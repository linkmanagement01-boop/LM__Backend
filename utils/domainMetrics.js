/**
 * Domain metrics for marketplace projects (free source: Open PageRank).
 *
 * - Open PageRank gives a 0–10 authority score + a global rank (no traffic). Key: OPENPAGERANK_API_KEY.
 * - If the domain is one of our publisher sites we also have its DA / DR / traffic.
 * - Results are cached per domain for 30 days; a manual refresh is allowed once a day.
 *   Nothing is fetched automatically in the background.
 * Built so a paid source (DR + organic traffic) can be added later in fetchExternal().
 */

const axios = require('axios');
const { query } = require('../config/database');

const CACHE_DAYS = 30;
const REFRESH_HOURS = 24;

/** "https://www.ABC.com/page" → "abc.com" (null when it isn't a domain) */
const normalizeDomain = (input) => {
    let d = String(input || '').trim().toLowerCase();
    d = d.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:\s]/)[0];
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) || d.length > 253) return null;
    return d;
};

let schemaReady = null;
const ensureSchema = () => (schemaReady = schemaReady || query(`
    CREATE TABLE IF NOT EXISTS domain_metrics (
        domain VARCHAR(255) PRIMARY KEY,
        opr_score NUMERIC(4,2),        -- Open PageRank 0–10
        opr_rank BIGINT,               -- Open PageRank global rank
        status VARCHAR(20) NOT NULL,   -- ok | not_found | not_configured | failed
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch(err => { schemaReady = null; throw err; }));

/** Calls Open PageRank for up to 100 domains; returns Map(domain → {opr_score, opr_rank, status}) */
const fetchOpenPageRank = async (domains) => {
    const out = new Map();
    const key = process.env.OPENPAGERANK_API_KEY;
    if (!key) {
        domains.forEach(d => out.set(d, { status: 'not_configured' }));
        return out;
    }
    try {
        const params = new URLSearchParams();
        domains.slice(0, 100).forEach(d => params.append('domains[]', d));
        const { data } = await axios.get(`https://openpagerank.com/api/v1.0/getPageRank?${params}`, {
            headers: { 'API-OPR': key }, timeout: 15000
        });
        for (const r of data?.response || []) {
            const d = normalizeDomain(r.domain);
            if (!d) continue;
            const found = Number(r.status_code) === 200 && r.page_rank_decimal !== '' && r.page_rank_decimal !== null;
            out.set(d, found
                ? { status: 'ok', opr_score: Number(r.page_rank_decimal), opr_rank: r.rank ? Number(r.rank) : null }
                : { status: 'not_found' });
        }
    } catch (err) {
        console.error('[DomainMetrics] Open PageRank failed:', err.response?.status || err.message);
        domains.forEach(d => { if (!out.has(d)) out.set(d, { status: 'failed' }); });
    }
    domains.forEach(d => { if (!out.has(d)) out.set(d, { status: 'not_found' }); });
    return out;
};

/** Our own numbers when the domain is one of our publisher sites */
const internalMetrics = async (domains) => {
    if (!domains.length) return new Map();
    const rows = (await query(
        `SELECT LOWER(REGEXP_REPLACE(REGEXP_REPLACE(root_domain, '^https?://', ''), '^www\\.', '')) AS domain,
                MAX(NULLIF(da, 0)) AS da, MAX(CASE WHEN dr <= 100 THEN NULLIF(dr, 0) END) AS dr,
                MAX(CASE WHEN traffic_source::text ~ '^[0-9]+(\\.[0-9]+)?$' THEN traffic_source::numeric END) AS traffic
         FROM new_sites
         WHERE LOWER(REGEXP_REPLACE(REGEXP_REPLACE(root_domain, '^https?://', ''), '^www\\.', '')) = ANY($1::text[])
           AND (delete_site IS NULL OR delete_site = 0)
         GROUP BY 1`,
        [domains]
    )).rows;
    return new Map(rows.map(r => [r.domain, { da: r.da === null ? null : Number(r.da), dr: r.dr === null ? null : Number(r.dr), traffic: r.traffic === null ? null : Number(r.traffic) }]));
};

/**
 * Metrics for several domains. Uses the cache; fetches only missing/expired ones (or all, with force).
 * Returns Map(domain → { opr_score, opr_rank, status, fetched_at, da, dr, traffic })
 */
const getMetrics = async (domainList, { force = false } = {}) => {
    await ensureSchema();
    const domains = [...new Set(domainList.map(normalizeDomain).filter(Boolean))];
    if (!domains.length) return new Map();

    const cached = new Map((await query(
        `SELECT domain, opr_score::float AS opr_score, opr_rank, status, fetched_at,
                (fetched_at > NOW() - ($2 || ' days')::interval) AS fresh,
                (fetched_at > NOW() - ($3 || ' hours')::interval) AS recent
         FROM domain_metrics WHERE domain = ANY($1::text[])`,
        [domains, CACHE_DAYS, REFRESH_HOURS]
    )).rows.map(r => [r.domain, r]));

    // Fetch: never fetched, expired, a failed / unconfigured attempt (once the key exists), or a forced refresh (max once a day)
    const toFetch = domains.filter(d => {
        const c = cached.get(d);
        if (!c) return true;
        if (force) return !c.recent || c.status !== 'ok';
        if (c.status === 'not_configured') return !!process.env.OPENPAGERANK_API_KEY;
        return !c.fresh || (c.status === 'failed' && !c.recent);
    });
    if (toFetch.length) {
        const fetched = await fetchOpenPageRank(toFetch);
        for (const [d, m] of fetched) {
            await query(
                `INSERT INTO domain_metrics (domain, opr_score, opr_rank, status, fetched_at) VALUES ($1,$2,$3,$4,NOW())
                 ON CONFLICT (domain) DO UPDATE SET opr_score = EXCLUDED.opr_score, opr_rank = EXCLUDED.opr_rank,
                   status = EXCLUDED.status, fetched_at = NOW()`,
                [d, m.opr_score ?? null, m.opr_rank ?? null, m.status]
            );
            cached.set(d, { domain: d, ...m, fetched_at: new Date() });
        }
    }

    const internal = await internalMetrics(domains);
    return new Map(domains.map(d => {
        const c = cached.get(d) || { status: 'not_found' };
        return [d, { domain: d, opr_score: c.opr_score ?? null, opr_rank: c.opr_rank ?? null, status: c.status, fetched_at: c.fetched_at || null, ...(internal.get(d) || {}) }];
    }));
};

module.exports = { normalizeDomain, getMetrics, ensureSchema };
