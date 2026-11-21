/**
 * Contact Finder – public contact details a website shows: e-mail addresses and social profiles
 * (LinkedIn, YouTube, Facebook, Instagram, X / Twitter, TikTok, Pinterest, Snapchat, Telegram, Threads).
 *
 * Reads the homepage + up to 5 contact-type pages linked from it (contact, about, write for us, advertise, privacy…).
 * Free – plain page reads from our server, no paid API. Honest user agent; sites that block bots or hide their
 * e-mail on purpose (Cloudflare e-mail protection, images) are reported as such – never worked around.
 */

const USER_AGENT = 'Mozilla/5.0 (compatible; LinkManagementBot/1.0; +https://www.linkmanagement.net)';
const MAX_BYTES = 1_500_000;
const PAGE_TIMEOUT = 12000;

const bareDomain = (d) => String(d || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');

/** GET a page → { ok, status, url, html, blocked } */
const getPage = async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT);
    try {
        const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en' } });
        const type = res.headers.get('content-type') || '';
        let html = '';
        if (/html|text\/plain/i.test(type) || !type) {
            const reader = res.body?.getReader();
            if (reader) {
                const chunks = []; let size = 0;
                for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length; if (size > MAX_BYTES) { ctrl.abort(); break; } }
                html = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
            }
        }
        // bot protection page (Cloudflare "Just a moment", captcha, 403/429/503 with a challenge)
        const blocked = (res.status === 403 || res.status === 429 || res.status === 503) && (/cf-mitigated|challenge|captcha|just a moment|attention required|access denied/i.test(html) || !!res.headers.get('cf-mitigated'))
            || /<title>\s*(just a moment|attention required|access denied)/i.test(html);
        return { ok: res.ok && !blocked, status: res.status, url: res.url || url, html, blocked };
    } catch (err) {
        return { ok: false, status: 0, url, html: '', blocked: false, error: err.name === 'AbortError' ? 'timed out' : (err.cause?.code || err.message) };
    } finally { clearTimeout(timer); }
};

const decodeEntities = (s) => String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&(amp|commat);/gi, (m, n) => (n.toLowerCase() === 'amp' ? '&' : '@'))
    .replace(/&period;/gi, '.');

// ── e-mails ──
// an address is found by scanning outwards from each "@" (a plain regex over the whole page can take minutes on
// pages with huge inline image data – it froze the server on cannabis360.us)
const LOCAL_CH = /[a-z0-9._%+-]/i, DOMAIN_CH = /[a-z0-9.-]/i;
const emailsAroundAt = (text) => {
    const out = [];
    let at = text.indexOf('@'), n = 0;
    while (at !== -1 && n++ < 5000) {
        let s = at; while (s > 0 && at - s < 64 && LOCAL_CH.test(text[s - 1])) s--;
        let e = at + 1; while (e < text.length && e - at < 253 && DOMAIN_CH.test(text[e])) e++;
        const cand = text.slice(s, e).replace(/[.-]+$/, '');
        if (s < at && /^[^@]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/i.test(cand)) out.push(cand.toLowerCase());
        at = text.indexOf('@', at + 1);
    }
    return out;
};
const JUNK_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js|ico)$|@(\d+x|example\.|domain\.|email\.|yourdomain|yoursite|sentry|wixpress|sentry-next)|^(you|your|name|email|user|username|someone|test|john|jane|johndoe|jdoe)@|@(yourorg|yourcompany|yourname|company|mysite|website)\.|u003e|\.(local|invalid|test)$/i;
const extractEmails = (html) => {
    // escaped text inside page scripts (a literal backslash-n before "support@…", unicode escapes) would glue extra letters onto an address
    const text = decodeEntities(html).replace(/\\[nrt]/g, ' ').replace(/\\u00[0-9a-f]{2}/gi, ' ').replace(/\\\//g, '/');
    const found = new Set();
    for (const m of text.matchAll(/mailto:([^"'?\s>]+)/gi)) { try { found.add(decodeURIComponent(m[1]).trim().toLowerCase()); } catch { found.add(m[1].trim().toLowerCase()); } }
    for (const e of emailsAroundAt(text)) found.add(e);
    return [...found].map(e => e.replace(/^[.\-_]+|[.\-_]+$/g, '')).filter(e => /^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/i.test(e) && !JUNK_EMAIL.test(e) && e.length <= 80);
};
// e-mail hidden on purpose by the site (we report it, we don't decode it)
// (bounded repeats only – unbounded ones are slow on long runs of letters)
const hiddenEmail = (html) => /data-cfemail|__cf_email__|\/cdn-cgi\/l\/email-protection/i.test(html) || /[a-z0-9._-]{1,64}\s{0,3}[[(]\s{0,3}at\s{0,3}[\])]\s{0,3}[a-z0-9.-]{1,64}\s{0,3}[[(]\s{0,3}dot\s{0,3}[\])]/i.test(html);

// ── social profiles ──
const SOCIAL = [
    { key: 'linkedin', label: 'LinkedIn', host: /(^|\.)linkedin\.com$/, handle: (p) => (p.match(/^\/(company|in|school|showcase)\/([^/?#]+)/i) || [])[2] && `${p.match(/^\/(company|in|school|showcase)\//i)[1].toLowerCase()}/${p.match(/^\/(company|in|school|showcase)\/([^/?#]+)/i)[2]}` },
    { key: 'youtube', label: 'YouTube', host: /(^|\.)youtube\.com$/, handle: (p) => (p.match(/^\/(@[^/?#]+)/) || [])[1] || ((p.match(/^\/(channel|c|user)\/([^/?#]+)/i) || [])[2] && p.match(/^\/((channel|c|user)\/[^/?#]+)/i)[1]) },
    { key: 'facebook', label: 'Facebook', host: /(^|\.)(facebook|fb)\.com$/, handle: (p) => { const m = p.match(/^\/(?:pg\/)?([^/?#]+)/); if (!m || /^(sharer|share|dialog|tr|plugins|groups|events|login|watch|photo\.php|permalink\.php|story\.php|hashtag|policies|help)$/i.test(m[1])) return (p.match(/^\/groups\/([^/?#]+)/) || [])[1] ? `groups/${p.match(/^\/groups\/([^/?#]+)/)[1]}` : null; return m[1] === 'profile.php' ? null : m[1]; } },
    { key: 'instagram', label: 'Instagram', host: /(^|\.)instagram\.com$/, handle: (p) => { const m = p.match(/^\/([^/?#]+)/); return m && !/^(p|reel|reels|explore|accounts|stories|tv|share)$/i.test(m[1]) ? m[1] : null; } },
    { key: 'x', label: 'X / Twitter', host: /(^|\.)(twitter|x)\.com$/, handle: (p) => { const m = p.match(/^\/([^/?#]+)/); return m && !/^(intent|share|home|search|hashtag|i|widgets|login|status)$/i.test(m[1]) ? m[1] : null; } },
    { key: 'tiktok', label: 'TikTok', host: /(^|\.)tiktok\.com$/, handle: (p) => (p.match(/^\/(@[^/?#]+)/) || [])[1] || null },
    { key: 'pinterest', label: 'Pinterest', host: /(^|\.)pinterest\.[a-z.]+$/, handle: (p) => { const m = p.match(/^\/([^/?#]+)/); return m && !/^(pin|search|ideas|today|_)$/i.test(m[1]) ? m[1] : null; } },
    { key: 'snapchat', label: 'Snapchat', host: /(^|\.)snapchat\.com$/, handle: (p) => (p.match(/^\/(?:add|@)\/?([^/?#]+)/i) || [])[1] || null },
    { key: 'telegram', label: 'Telegram', host: /^(t\.me|telegram\.me)$/, handle: (p) => { const m = p.match(/^\/([^/?#]+)/); return m && !/^(share|joinchat|s)$/i.test(m[1]) ? m[1] : null; } },
    { key: 'threads', label: 'Threads', host: /(^|\.)threads\.(net|com)$/, handle: (p) => (p.match(/^\/(@[^/?#]+)/) || [])[1] || null }
];
const extractSocials = (html, baseUrl) => {
    const out = {};
    for (const m of String(html).matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
        let u; try { u = new URL(decodeEntities(m[1]), baseUrl); } catch { continue; }
        const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|[a-z]{2})\./, '');
        const s = SOCIAL.find(x => x.host.test(host) || x.host.test(u.hostname.toLowerCase()));
        if (!s) continue;
        let handle; try { handle = s.handle(decodeURIComponent(u.pathname)); } catch { handle = null; }
        if (!handle) continue;
        handle = handle.replace(/\/+$/, '');
        const url = `https://${s.host.source.includes('t\\.me') ? 't.me' : host === 'fb.com' ? 'facebook.com' : host}/${handle}`;
        out[s.key] = out[s.key] || [];
        if (!out[s.key].some(x => x.handle.toLowerCase() === handle.toLowerCase())) out[s.key].push({ handle, url });
    }
    return out;
};

// contact-type pages linked from the homepage (same site)
const PAGE_HINT = /contact|about|write-?for-?us|guest-?post|advertis|sponsor|work-?with-?us|submit|team|impressum|imprint|privacy|reach-?us|get-?in-?touch|partner/i;
const pickPages = (html, baseUrl, site) => {
    const scored = new Map();
    for (const m of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
        let u; try { u = new URL(decodeEntities(m[1]), baseUrl); } catch { continue; }
        if (!/^https?:$/.test(u.protocol) || bareDomain(u.hostname) !== site) continue;
        const label = m[2].replace(/<[^>]+>/g, ' ');
        if (!PAGE_HINT.test(u.pathname) && !PAGE_HINT.test(label)) continue;
        const key = u.origin + u.pathname.replace(/\/+$/, '');
        const score = /contact|get-?in-?touch|reach-?us/i.test(u.pathname + label) ? 3 : /write-?for-?us|advertis|guest|sponsor|work-?with/i.test(u.pathname + label) ? 2 : 1;
        scored.set(key, Math.max(scored.get(key) || 0, score));
    }
    return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
};

/** Find the contact details of one domain */
const findContacts = async (input) => {
    const site = bareDomain(input);
    const result = { domain: site, status: 'ok', emails: [], socials: {}, pages_checked: [], contact_form: null, note: '' };
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(site)) return { ...result, status: 'invalid', note: 'Not a valid domain' };

    // homepage (https, then www., then http)
    let home = null;
    for (const url of [`https://${site}/`, `https://www.${site}/`, `http://${site}/`]) {
        const p = await getPage(url);
        if (p.ok || p.blocked) { home = p; break; }
        home = home || p;
    }
    if (!home?.ok) {
        if (home?.blocked) return { ...result, status: 'blocked', note: 'Site blocked the check (bot protection)' };
        // technical error → plain words for the team
        const e = String(home?.error || '');
        const why = /ENOTFOUND|EAI_AGAIN/.test(e) ? 'domain has no website'
            : /CERT|SSL|TLS/i.test(e) ? "site's security certificate is broken"
                : /timed out/.test(e) ? 'site too slow to answer'
                    : /ECONNREFUSED|ECONNRESET|SOCKET|EPIPE/i.test(e) ? 'site refused the connection'
                        : home?.status === 404 ? 'homepage not found (404)'
                            : home?.status >= 500 ? `site error (HTTP ${home.status})`
                                : home?.status ? `HTTP ${home.status}` : e || 'unknown error';
        return { ...result, status: 'unreachable', note: `Site not reachable – ${why}` };
    }
    const emails = new Set(extractEmails(home.html));
    let socials = extractSocials(home.html, home.url);
    let hidden = hiddenEmail(home.html);
    result.pages_checked.push(home.url);

    // contact-type pages
    for (const url of pickPages(home.html, home.url, site)) {
        const p = await getPage(url);
        if (!p.ok) continue;
        result.pages_checked.push(p.url);
        extractEmails(p.html).forEach(e => emails.add(e));
        const s = extractSocials(p.html, p.url);
        for (const [k, list] of Object.entries(s)) { socials[k] = socials[k] || []; for (const x of list) if (!socials[k].some(y => y.handle.toLowerCase() === x.handle.toLowerCase())) socials[k].push(x); }
        if (hiddenEmail(p.html)) hidden = true;
        if (!result.contact_form && /contact|get-?in-?touch|reach-?us/i.test(p.url) && /<form\b/i.test(p.html)) result.contact_form = p.url;
    }
    // the site's own addresses first, then the rest
    result.emails = [...emails].sort((a, b) => (bareDomain(b.split('@')[1]).endsWith(site) - bareDomain(a.split('@')[1]).endsWith(site)) || a.localeCompare(b)).slice(0, 15);
    result.socials = socials;
    if (!result.emails.length) result.note = hidden ? 'Email hidden by the site (check by hand)' : result.contact_form ? 'Contact form only' : 'No email shown on the site';
    return result;
};

module.exports = { findContacts, SOCIAL: SOCIAL.map(({ key, label }) => ({ key, label })), bareDomain };
