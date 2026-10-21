/**
 * PayPal (Orders v2 REST API) – used for marketplace wallet top-ups
 *
 * Env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_MODE = sandbox (default, test money) | live
 * Flow: create an order on our server → client approves in the PayPal popup → our server captures it
 * and only then credits the wallet (amounts are never trusted from the browser).
 */

const axios = require('axios');

const baseUrl = () => (String(process.env.PAYPAL_MODE || 'sandbox').toLowerCase() === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com');

const isConfigured = () => {
    const id = (process.env.PAYPAL_CLIENT_ID || '').trim();
    const secret = (process.env.PAYPAL_CLIENT_SECRET || '').trim();
    return !!id && !!secret && !/^your[_-]/i.test(id) && !/^your[_-]/i.test(secret);
};

let cachedToken = null; // { token, expiresAt }
const getAccessToken = async () => {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.token;
    const res = await axios.post(`${baseUrl()}/v1/oauth2/token`, 'grant_type=client_credentials', {
        auth: { username: process.env.PAYPAL_CLIENT_ID.trim(), password: process.env.PAYPAL_CLIENT_SECRET.trim() },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20000
    });
    cachedToken = { token: res.data.access_token, expiresAt: Date.now() + (res.data.expires_in || 300) * 1000 };
    return cachedToken.token;
};

const paypalError = (err, what) => {
    const d = err.response?.data;
    const detail = d?.details?.[0]?.description || d?.message || d?.error_description || err.message;
    const e = new Error(`PayPal ${what} failed: ${detail}`);
    e.statusCode = 502;
    return e;
};

/** Create a PayPal order for `amount` USD; returns the PayPal order id */
const createOrder = async (amount, referenceId) => {
    try {
        const token = await getAccessToken();
        const res = await axios.post(`${baseUrl()}/v2/checkout/orders`, {
            intent: 'CAPTURE',
            purchase_units: [{
                reference_id: String(referenceId).slice(0, 256),
                description: 'Wallet top-up',
                amount: { currency_code: 'USD', value: Number(amount).toFixed(2) }
            }]
        }, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
        return res.data.id;
    } catch (err) {
        throw paypalError(err, 'order');
    }
};

/**
 * Capture an approved PayPal order. Returns { status, captureId, amount, currency }.
 * Only status 'COMPLETED' means the money was actually received.
 */
const captureOrder = async (paypalOrderId) => {
    try {
        const token = await getAccessToken();
        const res = await axios.post(`${baseUrl()}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {}, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 30000
        });
        const capture = res.data?.purchase_units?.[0]?.payments?.captures?.[0];
        return {
            status: capture?.status || res.data?.status,
            captureId: capture?.id || null,
            amount: capture ? Number(capture.amount?.value) : null,
            currency: capture?.amount?.currency_code || null
        };
    } catch (err) {
        // Already captured (double click, or our server stopped right after capturing): read what PayPal
        // actually received, so the caller can still credit the wallet exactly once
        if (err.response?.data?.details?.[0]?.issue === 'ORDER_ALREADY_CAPTURED') {
            try {
                const token = await getAccessToken();
                const res = await axios.get(`${baseUrl()}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, {
                    headers: { Authorization: `Bearer ${token}` }, timeout: 20000
                });
                const capture = res.data?.purchase_units?.[0]?.payments?.captures?.[0];
                return {
                    status: capture?.status || 'UNKNOWN',
                    captureId: capture?.id || null,
                    amount: capture ? Number(capture.amount?.value) : null,
                    currency: capture?.amount?.currency_code || null
                };
            } catch (e2) {
                throw paypalError(e2, 'order lookup');
            }
        }
        throw paypalError(err, 'capture');
    }
};

module.exports = { isConfigured, createOrder, captureOrder, clientId: () => (process.env.PAYPAL_CLIENT_ID || '').trim(), mode: () => (String(process.env.PAYPAL_MODE || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox') };
