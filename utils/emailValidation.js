const dns = require('dns').promises;
const MailChecker = require('mailchecker');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const DISPOSABLE_MESSAGE =
    'Temporary or disposable email addresses are not allowed. Please use your real email address.';

const withTimeout = (promise, ms) =>
    Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), ms)
        )
    ]);

// "Not found" style DNS answers mean the domain truly has no such record.
// Anything else (timeout, server error) is treated as temporary, so a real user is not blocked.
const isNotFound = (err) => err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA');

// Domains you add yourself, comma separated, e.g. EXTRA_BLOCKED_EMAIL_DOMAINS=baddomain.com,other.net
const getExtraBlockedDomains = () =>
    (process.env.EXTRA_BLOCKED_EMAIL_DOMAINS || '')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
// Mail server hostnames of disposable services, comma separated, e.g. EXTRA_BLOCKED_MX_HOSTS=mail.tempservice.com
const getExtraBlockedMxHosts = () =>
    (process.env.EXTRA_BLOCKED_MX_HOSTS || '')
        .split(',')
        .map((d) => d.trim().toLowerCase().replace(/\.$/, ''))
        .filter(Boolean);
// Live check against Kickbox's free disposable-domain list (kept up to date).
// If the service is slow or down, we do not block the user.
const isDisposableOnline = async (domain) => {
    try {
        const res = await fetch(
            `https://open.kickbox.com/v1/disposable/${encodeURIComponent(domain)}`,
            { signal: AbortSignal.timeout(3000) }
        );
        if (!res.ok) return false;
        const data = await res.json();
        return data && data.disposable === true;
    } catch (err) {
        return false;
    }
};

/**
 * Checks a signup email.
 * Returns { ok: true } or { ok: false, message: '...' }
 */
const validateSignupEmail = async (rawEmail) => {
    const email = String(rawEmail || '').toLowerCase().trim();

    // 1. Format
    if (email.length > 254 || !EMAIL_REGEX.test(email)) {
        return { ok: false, message: 'Please enter a valid email address' };
    }

    const domain = email.split('@')[1];

    // 2. Domains you blocked yourself
    if (getExtraBlockedDomains().includes(domain)) {
        return { ok: false, message: DISPOSABLE_MESSAGE };
    }

    // 3. Known temporary / disposable email services (built-in list)
    if (!MailChecker.isValid(email)) {
        return { ok: false, message: DISPOSABLE_MESSAGE };
    }

    // 4. Known disposable services (live list)
    if (await isDisposableOnline(domain)) {
        return { ok: false, message: DISPOSABLE_MESSAGE };
    }

    // 5. The domain must exist and be able to receive mail
    try {
        const mx = await withTimeout(dns.resolveMx(domain), 4000);

        // Mail servers of known disposable services (one service can own thousands of changing domains)
        const blockedMxHosts = getExtraBlockedMxHosts();
        const usesBlockedMx = mx.some((r) => {
            const host = String(r.exchange || '').toLowerCase().replace(/\.$/, '');
            return blockedMxHosts.some((b) => host === b || host.endsWith('.' + b));
        });
        if (usesBlockedMx) return { ok: false, message: DISPOSABLE_MESSAGE };

        if (mx.some((r) => r.exchange && r.exchange !== '.')) return { ok: true };
    } catch (err) {
        if (!isNotFound(err)) return { ok: true };
    }

    // No MX records: mail servers fall back to the domain's address record
    try {
        const addresses = await withTimeout(dns.resolve4(domain), 4000);
        if (addresses.length > 0) return { ok: true };
    } catch (err) {
        if (!isNotFound(err)) return { ok: true };
    }

    return {
        ok: false,
        message: 'This email domain cannot receive mail. Please check the address and try again.'
    };
};

module.exports = { validateSignupEmail };