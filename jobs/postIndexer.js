/**
 * Post Indexer
 *
 * Bloggers only give us domains, not post links. To let the team search posts by keyword,
 * this job reads each active site's public sitemap and saves its post links in `site_posts`.
 *
 * - Runs daily (POST_INDEXER_HOUR, default 2 = 02:00 server time) and resumes any site never indexed on startup.
 * - Incremental: a child sitemap whose <lastmod> hasn't changed is not downloaded again.
 * - Keeps the newest MAX_POSTS_PER_SITE posts per site.
 * - Polite: a few sites at a time, timeouts and size limits.
 *
 * Disable with POST_INDEXER_ENABLED=false (e.g. on a local dev machine).
 * Manual run: node scripts/index-site-posts.js [--limit N] [--site ID]
 */


const axios = require('axios');
const zlib = require('zlib');
const { query } = require('../config/database');
const { activeSiteSql } = require('../utils/bloggerStatus');

// Newest posts kept per site (keeps the database small: ~400 MB for all sites at 400, vs ~1.3 GB at 2000). Override: POST_INDEXER_MAX_PER_SITE
const MAX_POSTS_PER_SITE = Math.max(50, parseInt(process.env.POST_INDEXER_MAX_PER_SITE, 10) || 400);
const CONCURRENCY = 6;
const TIMEOUT_MS = 15000;
const MAX_SITEMAP_BYTES = 15 * 1024 * 1024;
const MAX_CHILD_SITEMAPS = 40;
const STALE_DAYS = 14; // posts not seen in any sitemap for this long are removed
const USER_AGENT = 'Mozilla/5.0 (compatible; LinkManagementBot/1.0; +https://www.linkmanagement.net)';

let running = false;

// ─── Schema (created automatically, so no manual migration is needed) ──
const ensureSchema = async () => {
    await query(`
        CREATE TABLE IF NOT EXISTS site_posts (
            id BIGSERIAL PRIMARY KEY,
            site_id BIGINT NOT NULL,
            url TEXT NOT NULL,
            title TEXT,
            search_text TEXT NOT NULL,
            lastmod TIMESTAMPTZ,
            source_sitemap TEXT,
            first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS site_posts_site_url_uq ON site_posts (site_id, url)`);
    await query(`CREATE INDEX IF NOT EXISTS site_posts_site_idx ON site_posts (site_id)`);
    await query(`
        CREATE TABLE IF NOT EXISTS site_post_sources (
            site_id BIGINT PRIMARY KEY,
            domain TEXT,
            sitemap_url TEXT,
            child_lastmods JSONB NOT NULL DEFAULT '{}'::jsonb,
            status TEXT,
            error TEXT,
            post_count INT NOT NULL DEFAULT 0,
            last_indexed_at TIMESTAMPTZ
        )`);
    // Fast "contains word" search. Optional: if the extension can't be enabled, search still works (slower).
    try {
        await query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
        await query(`CREATE INDEX IF NOT EXISTS site_posts_search_trgm ON site_posts USING gin (search_text gin_trgm_ops)`);
    } catch (err) {
        console.warn('[PostIndexer] pg_trgm not available – keyword search will be slower:', err.message);
    }
};

// ─── Helpers ──────────────────────────────────────────────────────────
const normalizeDomain = (d) => String(d || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');

const fetchText = async (url) => {
    const res = await axios.get(url, {
        timeout: TIMEOUT_MS,
        responseType: 'arraybuffer',
        maxContentLength: MAX_SITEMAP_BYTES,
        maxRedirects: 5,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml,text/xml,text/plain,*/*' },
        validateStatus: s => s === 200
    });
    let buf = Buffer.from(res.data);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf); // .xml.gz
    return buf.toString('utf8');
};

const decodeXml = (s) => String(s || '').trim()
    .replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();

const parseDate = (s) => {
    const d = s ? new Date(decodeXml(s)) : null;
    return d && !isNaN(d) ? d : null;
};

/** Parse a sitemap: { type: 'index'|'urlset'|null, entries: [{ loc, lastmod }] } */
const parseSitemap = (xml) => {
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const isUrlset = /<urlset[\s>]/i.test(xml);
    if (!isIndex && !isUrlset) return { type: null, entries: [] };
    const tag = isIndex ? 'sitemap' : 'url';
    const entries = [];
    const re = new RegExp(`<${tag}[\\s>]([\\s\\S]*?)</${tag}>`, 'gi');
    let m;
    while ((m = re.exec(xml)) !== null) {
        const loc = (m[1].match(/<loc>([\s\S]*?)<\/loc>/i) || [])[1];
        if (!loc) continue;
        const lastmod = (m[1].match(/<lastmod>([\s\S]*?)<\/lastmod>/i) || [])[1];
        entries.push({ loc: decodeXml(loc), lastmod: parseDate(lastmod) });
    }
    return { type: isIndex ? 'index' : 'urlset', entries };
};

// Child sitemaps that never contain blog posts
const NON_POST_SITEMAP = /(^|[\/_-])(page|pages|category|categories|tag|tags|post_tag|author|authors|users?|product|products|product_cat|product_tag|attachment|media|image|images|video|videos|web-story|web_story|webstories|taxonomy|taxonomies|elementor|e-landing-page|portfolio|locations?|faq)([\/_.-]|\d|$)/i;
const isPostSitemap = (loc) => {
    const file = loc.split('?')[0].split('/').pop() || '';
    if (/wp-sitemap-posts-post-/i.test(file)) return true;
    if (/wp-sitemap-(posts-(?!post-)|taxonomies|users)/i.test(file)) return false;
    return !NON_POST_SITEMAP.test(file.replace(/\.xml(\.gz)?$/i, ''));
};

// URLs that are listings, not posts
const NON_POST_URL = /\/(category|tag|author|page|feed|wp-content|wp-json|profile|profiles|users?|members?|shop|products?|cart|checkout|my-account)\//i;
const isPostUrl = (url, domain) => {
    try {
        const u = new URL(url);
        if (normalizeDomain(u.hostname) !== domain) return false;
        const path = u.pathname.replace(/\/+$/, '');
        if (!path || path === '' || NON_POST_URL.test(u.pathname + '/')) return false;
        return !/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|mp3|xml)$/i.test(path);
    } catch { return false; }
};

/** Human-readable title from the URL slug, e.g. ".../weed-delivery-guide/" → "Weed delivery guide" */
const titleFromUrl = (url) => {
    try {
        const segs = new URL(url).pathname.split('/').filter(Boolean);
        let slug = segs.pop() || '';
        if (/^\d+$/.test(slug) && segs.length) slug = segs.pop(); // ".../my-post/2" style
        slug = decodeURIComponent(slug).replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_+]+/g, ' ').trim();
        return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : null;
    } catch { return null; }
};

const searchTextFor = (url, title) => {
    let path = url;
    try { path = decodeURIComponent(new URL(url).pathname); } catch { /* keep url */ }
    return `${title || ''} ${path.replace(/[-_/+.]+/g, ' ')}`.toLowerCase().replace(/\s+/g, ' ').trim();
};

/** Find the site's sitemap: robots.txt first, then the usual locations */
const discoverSitemap = async (domain) => {
    const candidates = [];
    for (const base of [`https://${domain}`, `https://www.${domain}`]) {
        try {
            const robots = await fetchText(`${base}/robots.txt`);
            for (const line of robots.split(/\r?\n/)) {
                const m = line.match(/^\s*sitemap:\s*(\S+)/i);
                if (m) candidates.push(m[1]);
            }
        } catch { /* no robots.txt */ }
        candidates.push(`${base}/sitemap_index.xml`, `${base}/sitemap.xml`, `${base}/wp-sitemap.xml`, `${base}/post-sitemap.xml`);
        if (candidates.length > 4) break; // https://domain answered with sitemaps in robots, no need for www
    }
    for (const url of [...new Set(candidates)]) {
        try {
            const xml = await fetchText(url);
            const parsed = parseSitemap(xml);
            if (parsed.type) return { url, parsed };
        } catch { /* try next */ }
    }
    return null;
};

/** Save posts in batches (upsert) */
const upsertPosts = async (siteId, posts) => {
    for (let i = 0; i < posts.length; i += 500) {
        const batch = posts.slice(i, i + 500);
        await query(
            `INSERT INTO site_posts (site_id, url, title, search_text, lastmod, source_sitemap, last_seen_at)
             SELECT $1, u, t, s, l, src, NOW()
             FROM unnest($2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::text[]) AS x(u, t, s, l, src)
             ON CONFLICT (site_id, url) DO UPDATE
               SET title = EXCLUDED.title, search_text = EXCLUDED.search_text, lastmod = EXCLUDED.lastmod,
                   source_sitemap = EXCLUDED.source_sitemap, last_seen_at = NOW()`,
            [siteId, batch.map(p => p.url), batch.map(p => p.title), batch.map(p => p.search_text),
                batch.map(p => p.lastmod), batch.map(p => p.source)]
        );
    }
};

// ─── Index one site ───────────────────────────────────────────────────
const indexSite = async (site) => {
    const domain = normalizeDomain(site.root_domain);
    const prev = (await query(`SELECT child_lastmods FROM site_post_sources WHERE site_id = $1`, [site.id])).rows[0];
    const prevLastmods = prev?.child_lastmods || {};
    const newLastmods = {};

    const saveSource = (status, extra = {}) => query(
        `INSERT INTO site_post_sources (site_id, domain, sitemap_url, child_lastmods, status, error, post_count, last_indexed_at)
         VALUES ($1, $2, $3, $4, $5, $6, (SELECT COUNT(*) FROM site_posts WHERE site_id = $1), NOW())
         ON CONFLICT (site_id) DO UPDATE SET domain = EXCLUDED.domain, sitemap_url = EXCLUDED.sitemap_url,
           child_lastmods = EXCLUDED.child_lastmods, status = EXCLUDED.status, error = EXCLUDED.error,
           post_count = EXCLUDED.post_count, last_indexed_at = NOW()`,
        [site.id, domain, extra.sitemap || null, JSON.stringify(extra.lastmods || prevLastmods), status, extra.error || null]
    );

    if (!domain) return saveSource('no_domain');

    const found = await discoverSitemap(domain);
    if (!found) return saveSource('no_sitemap');

    // Collect post entries (urlset directly, or post sitemaps from the index – up to 2 levels deep)
    const posts = [];
    const unchangedChildren = [];
    const collectUrlset = (entries, source) => {
        for (const e of entries) {
            if (isPostUrl(e.loc, domain)) posts.push({ url: e.loc, lastmod: e.lastmod, source });
        }
    };

    if (found.parsed.type === 'urlset') {
        collectUrlset(found.parsed.entries, found.url);
    } else {
        let children = found.parsed.entries.filter(c => isPostSitemap(c.loc));
        // Newest first, so we reach the newest posts before the cap
        children.sort((a, b) => (b.lastmod?.getTime() || 0) - (a.lastmod?.getTime() || 0));
        children = children.slice(0, MAX_CHILD_SITEMAPS);
        for (const child of children) {
            const key = child.loc;
            const lm = child.lastmod ? child.lastmod.toISOString() : null;
            newLastmods[key] = lm;
            if (lm && prevLastmods[key] === lm) { unchangedChildren.push(key); continue; } // not changed since last run
            try {
                const parsed = parseSitemap(await fetchText(child.loc));
                if (parsed.type === 'urlset') collectUrlset(parsed.entries, key);
                else if (parsed.type === 'index') {
                    for (const g of parsed.entries.filter(x => isPostSitemap(x.loc)).slice(0, 10)) {
                        try {
                            const p2 = parseSitemap(await fetchText(g.loc));
                            if (p2.type === 'urlset') collectUrlset(p2.entries, key);
                        } catch { /* skip broken grandchild */ }
                    }
                }
            } catch {
                delete newLastmods[key]; // retry this child next time
            }
        }
    }

    // Newest posts first, keep at most MAX_POSTS_PER_SITE
    const unique = new Map();
    for (const p of posts) if (!unique.has(p.url)) unique.set(p.url, p);
    const newest = [...unique.values()]
        .sort((a, b) => (b.lastmod?.getTime() || 0) - (a.lastmod?.getTime() || 0))
        .slice(0, MAX_POSTS_PER_SITE)
        .map(p => {
            const title = titleFromUrl(p.url);
            return { ...p, title, search_text: searchTextFor(p.url, title) };
        });

    await upsertPosts(site.id, newest);
    if (unchangedChildren.length > 0) {
        await query(`UPDATE site_posts SET last_seen_at = NOW() WHERE site_id = $1 AND source_sitemap = ANY($2::text[])`,
            [site.id, unchangedChildren]);
    }
    // Remove posts that disappeared from the sitemaps, then enforce the per-site cap
    await query(`DELETE FROM site_posts WHERE site_id = $1 AND last_seen_at < NOW() - ($2 || ' days')::interval`, [site.id, STALE_DAYS]);
    await query(
        `DELETE FROM site_posts WHERE id IN (
            SELECT id FROM site_posts WHERE site_id = $1
            ORDER BY lastmod DESC NULLS LAST, first_seen_at DESC OFFSET $2)`,
        [site.id, MAX_POSTS_PER_SITE]
    );

    return saveSource(newest.length > 0 || unchangedChildren.length > 0 ? 'ok' : 'empty',
        { sitemap: found.url, lastmods: { ...prevLastmods, ...newLastmods } });
};

// ─── Run over all active sites ────────────────────────────────────────
/**
 * @param {object} opts
 * @param {number} [opts.limit]   only index this many sites (oldest-indexed first)
 * @param {number} [opts.siteId]  only index this site
 * @param {boolean} [opts.onlyNew] only sites never indexed
 */
const runIndexer = async ({ limit, siteId, onlyNew = false } = {}) => {
    if (running) {
        console.log('[PostIndexer] Already running – skipped');
        return null;
    }
    running = true;
    const started = Date.now();
    const stats = { sites: 0, ok: 0, no_sitemap: 0, empty: 0, failed: 0 };
    try {
        await ensureSchema();
        const params = [];
        let where = `(ns.delete_site IS NULL OR ns.delete_site = 0) AND ns.site_status = '1' AND ${activeSiteSql('ns')} AND ns.root_domain IS NOT NULL`;
        if (siteId) { params.push(siteId); where += ` AND ns.id = $${params.length}`; }
        if (onlyNew) where += ` AND sps.site_id IS NULL`;
        let sql = `SELECT ns.id, ns.root_domain FROM new_sites ns
                   LEFT JOIN site_post_sources sps ON sps.site_id = ns.id
                   WHERE ${where}
                   ORDER BY sps.last_indexed_at ASC NULLS FIRST, ns.id`;
        if (limit) { params.push(limit); sql += ` LIMIT $${params.length}`; }
        const sites = (await query(sql, params)).rows;
        console.log(`[PostIndexer] Indexing ${sites.length} site(s)...`);

        let i = 0;
        const worker = async () => {
            while (i < sites.length) {
                const site = sites[i++];
                try {
                    await indexSite(site);
                    const src = (await query(`SELECT status FROM site_post_sources WHERE site_id = $1`, [site.id])).rows[0];
                    stats[src?.status] = (stats[src?.status] || 0) + 1;
                } catch (err) {
                    stats.failed++;
                    await query(
                        `INSERT INTO site_post_sources (site_id, domain, status, error, last_indexed_at)
                         VALUES ($1, $2, 'failed', $3, NOW())
                         ON CONFLICT (site_id) DO UPDATE SET status = 'failed', error = EXCLUDED.error, last_indexed_at = NOW()`,
                        [site.id, normalizeDomain(site.root_domain), String(err.message).slice(0, 500)]
                    ).catch(() => {});
                }
                stats.sites++;
                if (stats.sites % 50 === 0) console.log(`[PostIndexer] ${stats.sites}/${sites.length} sites done`);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sites.length) }, worker));
        console.log(`[PostIndexer] Done in ${Math.round((Date.now() - started) / 1000)}s`, stats);
        return stats;
    } finally {
        running = false;
    }
};

/** Start the daily schedule (and finish any never-indexed sites shortly after startup) */
const startPostIndexer = () => {
    if (String(process.env.POST_INDEXER_ENABLED).toLowerCase() === 'false') {
        console.log('[PostIndexer] Disabled (POST_INDEXER_ENABLED=false)');
        return;
    }
    // Daily at POST_INDEXER_HOUR (server time, default 2 = 02:00)
    const hour = Math.min(23, Math.max(0, parseInt(process.env.POST_INDEXER_HOUR ?? '2', 10) || 0));
    const scheduleNext = () => {
        const next = new Date();
        next.setHours(hour, 0, 0, 0);
        if (next <= new Date()) next.setDate(next.getDate() + 1);
        setTimeout(() => {
            runIndexer().catch(err => console.error('[PostIndexer] Error:', err.message)).finally(scheduleNext);
        }, next - new Date());
    };
    ensureSchema().catch(err => console.error('[PostIndexer] Schema error:', err.message));
    scheduleNext();
    // After a deploy/restart, continue with sites that were never indexed (e.g. the first run)
    setTimeout(() => {
        runIndexer({ onlyNew: true }).catch(err => console.error('[PostIndexer] Error:', err.message));
    }, 60 * 1000);
    console.log(`[PostIndexer] Scheduled daily at ${String(hour).padStart(2, '0')}:00`);
};

module.exports = { startPostIndexer, runIndexer, ensureSchema, indexSite, parseSitemap, isPostSitemap, isPostUrl, titleFromUrl };
