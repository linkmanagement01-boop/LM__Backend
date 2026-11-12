/**
 * Razorpay (Orders API) – used for marketplace wallet top-ups (₹ for India, $ cards abroad once approved)
 *
 * Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (rzp_test_… = test money, rzp_live_… = real),
 *      RAZORPAY_WEBHOOK_SECRET (same value as in Razorpay → Webhooks),
 *      RAZORPAY_INTERNATIONAL=true once Razorpay has approved international payments
 * Flow: create an order on our server → client pays in the Razorpay popup → our server checks the
 * payment signature and the payment itself with Razorpay, and only then credits the wallet.
 * The webhook (payment.captured / order.paid) credits it too, if the browser closed after paying.
 */

const axios = require('axios');
const crypto = require('crypto');

const API = 'https://api.razorpay.com/v1';

const keyId = () => (process.env.RAZORPAY_KEY_ID || '').trim();
const keySecret = () => (process.env.RAZORPAY_KEY_SECRET || '').trim();

const isConfigured = () => !!keyId() && !!keySecret() && !/^your[_-]/i.test(keyId()) && !/^your[_-]/i.test(keySecret());
const mode = () => (keyId().startsWith('rzp_live_') ? 'live' : 'test');
const internationalEnabled = () => process.env.RAZORPAY_INTERNATIONAL === 'true';

const razorpayError = (err, what) => {
    const d = err.response?.data?.error;
    const e = new Error(`Razorpay ${what} failed: ${d?.description || err.message}`);
    e.statusCode = 502;
    return e;
};

const call = (method, path, data) => axios({
    method, url: `${API}${path}`, data,
    auth: { username: keyId(), password: keySecret() },
    timeout: 20000
}).then(r => r.data);

/** Create an order for `amountMinor` (paise / cents) in `currency`; returns the Razorpay order */
const createOrder = async (amountMinor, currency, receipt, notes) => {
    try {
        return await call('post', '/orders', { amount: amountMinor, currency, receipt: String(receipt).slice(0, 40), notes });
    } catch (err) {
        throw razorpayError(err, 'order');
    }
};

const fetchPayment = async (paymentId) => {
    try {
        return await call('get', `/payments/${encodeURIComponent(paymentId)}`);
    } catch (err) {
        throw razorpayError(err, 'payment lookup');
    }
};

/** Capture an authorized payment (when the account doesn't auto-capture); returns the payment */
const capturePayment = async (paymentId, amountMinor, currency) => {
    try {
        return await call('post', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountMinor, currency });
    } catch (err) {
        // already captured (double click / webhook got there first) – read what Razorpay has
        if (/already been captured/i.test(err.response?.data?.error?.description || '')) return fetchPayment(paymentId);
        throw razorpayError(err, 'capture');
    }
};

const safeEqual = (a, b) => {
    const x = Buffer.from(String(a || ''), 'utf8');
    const y = Buffer.from(String(b || ''), 'utf8');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** The checkout popup's signature: HMAC-SHA256(order_id|payment_id, key secret) */
const verifyPaymentSignature = (orderId, paymentId, signature) =>
    safeEqual(crypto.createHmac('sha256', keySecret()).update(`${orderId}|${paymentId}`).digest('hex'), signature);

/** Webhook signature: HMAC-SHA256(raw body, webhook secret) */
const verifyWebhookSignature = (rawBody, signature) => {
    const secret = (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
    if (!secret) return false;
    return safeEqual(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), signature);
};

module.exports = {
    isConfigured, keyId, mode, internationalEnabled,
    createOrder, fetchPayment, capturePayment, verifyPaymentSignature, verifyWebhookSignature
};
