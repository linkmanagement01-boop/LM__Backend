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

// Reads a comma separated environment variable into a clean list
const parseList = (value) =>
    String(value || '')
        .split(',')
        .map((s) => s.trim().toLowerCase().replace(/\.$/, ''))
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
 *
 * Railway variables you can set (all optional, comma separated):
 *   EXTRA_BLOCKED_EMAIL_DOMAINS  domains to block, e.g. baddomain.com
 *   EXTRA_BLOCKED_MX_HOSTS       mail server names of disposable services
 *   EXTRA_BLOCKED_MX_IPS         mail server IP addresses of disposable services
 */
const validateSignupEmail = async (rawEmail) => {
    const email = String(rawEmail || '').toLowerCase().trim();

    // 1. Format
    if (email.length > 254 || !EMAIL_REGEX.test(email)) {
        return { ok: false, message: 'Please enter a valid email address' };
    }

    const domain = email.split('@')[1];

    // 2. Domains you blocked yourself
    if (parseList(process.env.EXTRA_BLOCKED_EMAIL_DOMAINS).includes(domain)) {
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

    // 5. The domain must exist, be able to receive mail, and not use a blocked mail server
    const blockedMxHosts = parseList(process.env.EXTRA_BLOCKED_MX_HOSTS);
    const blockedMxIps = parseList(process.env.EXTRA_BLOCKED_MX_IPS);

    try {
        const mx = await withTimeout(dns.resolveMx(domain), 4000);
        const realMx = mx.filter((r) => r.exchange && r.exchange !== '.');

        // Mail server names that belong to disposable services
        const usesBlockedHost = realMx.some((r) => {
            const host = r.exchange.toLowerCase().replace(/\.$/, '');
            return blockedMxHosts.some((b) => host === b || host.endsWith('.' + b));
        });
        if (usesBlockedHost) return { ok: false, message: DISPOSABLE_MESSAGE };

        // Mail servers whose IP address belongs to a disposable service
        if (blockedMxIps.length > 0) {
            for (const r of realMx.slice(0, 5)) {
                const ips = await withTimeout(dns.resolve4(r.exchange), 3000).catch(() => []);
                if (ips.some((ip) => blockedMxIps.includes(ip))) {
                    return { ok: false, message: DISPOSABLE_MESSAGE };
                }
            }
        }

        if (realMx.length > 0) return { ok: true };
    } catch (err) {
        if (!isNotFound(err)) return { ok: true };
    }

    // No MX records: mail servers fall back to the domain's address record
    try {
        const addresses = await withTimeout(dns.resolve4(domain), 4000);
        if (addresses.some((ip) => blockedMxIps.includes(ip))) {
            return { ok: false, message: DISPOSABLE_MESSAGE };
        }
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