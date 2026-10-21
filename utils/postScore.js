/**
 * Keyword score for a blog post (team "Search Keyword" tab)
 *
 * Opens the post page once (cached for CACHE_DAYS), reads its H1/title and article text,
 * and scores how strongly the post is about the keyword:
 *
 *   Permalink (URL) ........ 30%  × share of keyword words in the URL
 *   H1 (or page title) ..... 30%  × share of keyword words in the heading
 *   Content ................ 40%  × per word: 3+ mentions = full, 2 = ⅔, 0–1 = nothing
 *
 * Words match when a word STARTS with the keyword word ("weed" → weed, weeds; not seaweed).
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { query } = require('../config/database');

const CACHE_DAYS = 30;
const TIMEOUT_MS = 12000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 200000;
const WEIGHTS = { url: 30, h1: 30, content: 40 };
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ensureSchema = async () => {
    await query(`
        CREATE TABLE IF NOT EXISTS post_page_cache (
            url TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            http_status INT,
            title TEXT,
            h1 TEXT,
            body_text TEXT,
            fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    // Domains linked from the article text (to skip posts that already link to the client)
    await query(`ALTER TABLE post_page_cache ADD COLUMN IF NOT EXISTS link_hosts TEXT[]`);
};

/** "https://www.Test.com/shop" → "test.com" */
const hostOf = (value) => {
    try {
        const s = String(value || '').trim();
        if (!s) return '';
        const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
        if (u.username || !u.hostname.includes('.')) return ''; // e.g. an email address typed as the website
        return u.hostname.toLowerCase().replace(/^www\./, '');
    } catch { return ''; }
};

/** Does any linked domain equal the client domain (or a subdomain of it)? */
const linksToDomain = (linkHosts, domain) =>
    !!domain && (linkHosts || []).some(h => h === domain || h.endsWith(`.${domain}`));
let schemaReady = null;
const schema = () => (schemaReady = schemaReady || ensureSchema().catch(err => { schemaReady = null; throw err; }));

// ─── Text helpers ─────────────────────────────────────────────────────
const tokenize = (text) => String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Share (0–1) of keyword words that start a word in `tokens` */
const shareFound = (words, tokens) => {
    if (!words.length) return 0;
    return words.filter(w => tokens.some(t => t.startsWith(w))).length / words.length;
};

/** How many times each keyword word appears in `tokens` */
const countEach = (words, tokens) => words.map(w => tokens.reduce((n, t) => n + (t.startsWith(w) ? 1 : 0), 0));

/** How many times the whole keyword appears as a phrase (words in order, next to each other) */
const countPhrase = (words, tokens) => {
    if (!words.length) return 0;
    let n = 0;
    for (let i = 0; i + words.length <= tokens.length; i++) {
        if (words.every((w, j) => tokens[i + j].startsWith(w))) n++;
    }
    return n;
};

// ─── Fetch + parse a post page (cached) ───────────────────────────────
const fetchPage = async (url) => {
    try {
        const res = await axios.get(url, {
            timeout: TIMEOUT_MS,
            maxContentLength: MAX_HTML_BYTES,
            maxRedirects: 5,
            responseType: 'text',
            headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
            validateStatus: () => true
        });
        if (res.status !== 200 || typeof res.data !== 'string') {
            return { status: 'blocked', http_status: res.status };
        }
        const $ = cheerio.load(res.data);
        const title = $('title').first().text().trim().slice(0, 500);
        const h1 = $('h1').first().text().replace(/\s+/g, ' ').trim().slice(0, 500);

        // Article text: drop menus/scripts, prefer the main article container
        $('script, style, noscript, nav, header, footer, aside, form, iframe, svg, .comments, #comments, .sidebar, .related, .related-posts').remove();
        const containers = ['article .entry-content', '.entry-content', '.post-content', '.single-content', 'article', 'main', '[role="main"]', 'body'];
        let body = '';
        let article = null;
        for (const sel of containers) {
            const el = $(sel).first();
            const t = el.text().replace(/\s+/g, ' ').trim();
            if (t.length > 300) { body = t; article = el; break; }
            if (!body && t) { body = t; article = el; }
        }
        // Pages that answer 200 but are really a bot check
        if (body.length < 200 && /captcha|cloudflare|access denied|are you a robot|just a moment/i.test(res.data.slice(0, 20000))) {
            return { status: 'blocked', http_status: 200 };
        }
        // Domains linked from the article text only (not menus, sidebars or footers – those were removed above)
        const linkHosts = new Set();
        if (article) {
            article.find('a[href]').each((_, a) => {
                try {
                    const host = new URL($(a).attr('href'), url).hostname.toLowerCase().replace(/^www\./, '');
                    if (host) linkHosts.add(host);
                } catch { /* ignore bad hrefs */ }
            });
        }
        return { status: 'ok', http_status: 200, title, h1, body_text: body.slice(0, MAX_TEXT_CHARS), link_hosts: [...linkHosts] };
    } catch (err) {
        return { status: 'error', http_status: null };
    }
};

const getPage = async (url, { force = false } = {}) => {
    await schema();
    const cached = (await query(
        `SELECT status, http_status, title, h1, body_text, link_hosts FROM post_page_cache
         WHERE url = $1 AND fetched_at > NOW() - ($2 || ' days')::interval
           AND ((status = 'ok' AND link_hosts IS NOT NULL)          -- pages saved before links were recorded are re-read once
                OR (status <> 'ok' AND fetched_at > NOW() - INTERVAL '1 day'))`, // retry failures after a day
        [url, CACHE_DAYS]
    )).rows[0];
    if (cached && !force) return cached; // force = re-read the live page now

    const page = await fetchPage(url);
    await query(
        `INSERT INTO post_page_cache (url, status, http_status, title, h1, body_text, link_hosts, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (url) DO UPDATE SET status = EXCLUDED.status, http_status = EXCLUDED.http_status,
           title = EXCLUDED.title, h1 = EXCLUDED.h1, body_text = EXCLUDED.body_text,
           link_hosts = EXCLUDED.link_hosts, fetched_at = NOW()`,
        [url, page.status, page.http_status, page.title || null, page.h1 || null, page.body_text || null,
            page.status === 'ok' ? (page.link_hosts || []) : null]
    );
    return page;
};

// ─── Score ────────────────────────────────────────────────────────────
const scorePost = (words, url, page, clientDomain = '') => {
    // true / false when we could read the article's links; null when the page couldn't be read
    const linksToClient = page.status === 'ok' && clientDomain ? linksToDomain(page.link_hosts, clientDomain) : null;
    let urlTokens = [];
    try { urlTokens = tokenize(decodeURIComponent(new URL(url).pathname)); } catch { urlTokens = tokenize(url); }
    const urlShare = shareFound(words, urlTokens);

    if (page.status !== 'ok') {
        return {
            url, status: page.status, score: null, links_to_client: linksToClient,
            parts: { url: Math.round(urlShare * 100), h1: null, content: null },
            mentions: null
        };
    }

    const heading = page.h1 || page.title || '';
    const headingTokens = tokenize(heading);
    const h1Share = shareFound(words, headingTokens);

    const bodyTokens = tokenize(page.body_text);
    const perWord = countEach(words, bodyTokens);
    // 3+ mentions = full, 2 = two thirds, 0–1 = nothing (one passing mention doesn't make a post "about" it)
    const contentShare = words.length
        ? perWord.reduce((s, n) => s + (n >= 3 ? 1 : n === 2 ? 2 / 3 : 0), 0) / words.length
        : 0;

    const score = Math.round(urlShare * WEIGHTS.url + h1Share * WEIGHTS.h1 + contentShare * WEIGHTS.content);
    return {
        url,
        status: 'ok',
        links_to_client: linksToClient,
        score,
        parts: {
            url: Math.round(urlShare * 100),
            h1: Math.round(h1Share * 100),
            content: Math.round(contentShare * 100)
        },
        heading: heading.slice(0, 200),
        // Mentions (single word: its count; several words: times the whole phrase appears).
        // The total = H1 + article, so it matches what the team sees with Ctrl+F on the post.
        h1_mentions: words.length === 1 ? countEach(words, headingTokens)[0] : countPhrase(words, headingTokens),
        content_mentions: words.length === 1 ? perWord[0] : countPhrase(words, bodyTokens),
        mentions: (words.length === 1 ? countEach(words, headingTokens)[0] : countPhrase(words, headingTokens))
            + (words.length === 1 ? perWord[0] : countPhrase(words, bodyTokens)),
        word_mentions: words.map((w, i) => ({ word: w, count: perWord[i] })) // per word, article only
    };
};

/** Score many posts, a few pages at a time */
const scorePosts = async (words, urls, { clientDomain = '', concurrency = 6 } = {}) => {
    const results = new Array(urls.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
        while (i < urls.length) {
            const idx = i++;
            const page = await getPage(urls[idx]).catch(() => ({ status: 'error' }));
            results[idx] = scorePost(words, urls[idx], page, clientDomain);
        }
    }));
    return results;
};

/**
 * Re-read one post live (ignoring the saved copy) and check whether its article links to the client.
 * Used when the team picks a post, so the check is up to date at that moment.
 */
const verifyPostLinks = async (url, clientDomain) => {
    const page = await getPage(url, { force: true });
    return {
        url,
        status: page.status,
        links_to_client: page.status === 'ok' && clientDomain ? linksToDomain(page.link_hosts, clientDomain) : null
    };
};

module.exports = { scorePosts, scorePost, verifyPostLinks, getPage, tokenize, hostOf, WEIGHTS };
