/**
 * Site traffic (Ahrefs free Traffic Checker)
 *
 * A manager/admin clicks "Check traffic" on View All Sites. The "LM Traffic Helper" Chrome extension
 * opens ahrefs.com/traffic-checker for the domain in their own browser (they solve the "I'm human" check),
 * captures the JSON the page loads and posts it here. We keep the raw capture and parse:
 *   organic traffic, traffic value, monthly history (graph) and top countries.
 *
 * The raw capture is stored, so if Ahrefs changes its data format we fix parse() and re-parse old checks
 * (reparseAll) without checking the sites again.
 */

const { query } = require('../config/database');

let schemaReady = null;
const ensureSchema = () => (schemaReady = schemaReady || (async () => {
    await query(`
        CREATE TABLE IF NOT EXISTS site_traffic (
            site_id BIGINT PRIMARY KEY,
            domain VARCHAR(255),
            organic_traffic BIGINT,
            traffic_value NUMERIC(14,2),
            history JSONB NOT NULL DEFAULT '[]',          -- [{ date: 'YYYY-MM', traffic }]
            top_countries JSONB NOT NULL DEFAULT '[]',    -- [{ country, share, traffic }]
            raw JSONB,                                    -- what the helper captured (for re-parsing)
            checked_by INT,
            checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    // Status rules after a check (utils/siteTrafficRules.js)
    await query(`ALTER TABLE site_traffic ADD COLUMN IF NOT EXISTS growth_pct NUMERIC(10,2)`);      // last 3 months vs the 3 before
    await query(`ALTER TABLE site_traffic ADD COLUMN IF NOT EXISTS rule_action VARCHAR(20)`);       // auto_rejected | suggested
    await query(`ALTER TABLE site_traffic ADD COLUMN IF NOT EXISTS rule_at TIMESTAMPTZ`);
    await query(`ALTER TABLE site_traffic ADD COLUMN IF NOT EXISTS rule_resolved VARCHAR(20)`);     // activated | kept | undone | confirmed | expired
    await query(`ALTER TABLE site_traffic ADD COLUMN IF NOT EXISTS resolved_by INT`);
    await query(`ALTER TABLE site_traffic ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`);
    await query(`
        CREATE TABLE IF NOT EXISTS site_traffic_log (
            id SERIAL PRIMARY KEY,
            site_id BIGINT NOT NULL,
            action VARCHAR(20) NOT NULL,          -- auto_rejected | suggested | activated | kept | undone | confirmed
            organic_traffic BIGINT,
            growth_pct NUMERIC(10,2),
            user_id INT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
})().catch(err => { schemaReady = null; throw err; }));

// ─── Parsing ──────────────────────────────────────────────────────────

const num = (v) => {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return parseFloat(v);
    return null;
};

const isPlainObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Walk every value in a JSON tree: fn(key, value, parent) */
const walk = (node, fn, key = null, parent = null, depth = 0) => {
    if (depth > 30 || node === null || node === undefined) return;
    fn(key, node, parent);
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, fn, i, node, depth + 1));
    else if (typeof node === 'object') Object.keys(node).forEach(k => walk(node[k], fn, k, node, depth + 1));
};

const DATE_RE = /^\d{4}-\d{2}(-\d{2})?/;

/** Monthly history: the longest array of objects that each have a date and a number */
const findHistory = (roots) => {
    let best = [];
    roots.forEach(root => walk(root, (k, v) => {
        if (!Array.isArray(v) || v.length < 2 || !v.every(isPlainObj)) return;
        const dateKey = Object.keys(v[0]).find(key => typeof v[0][key] === 'string' && DATE_RE.test(v[0][key]));
        if (!dateKey) return;
        const numKeys = Object.keys(v[0]).filter(key => key !== dateKey && num(v[0][key]) !== null);
        if (!numKeys.length) return;
        const valKey = numKeys.find(key => /organic/i.test(key)) || numKeys.find(key => /traffic/i.test(key))
            || numKeys.find(key => /value/i.test(key)) || numKeys[0];
        const rows = v.filter(r => typeof r[dateKey] === 'string' && DATE_RE.test(r[dateKey]))
            .map(r => ({ date: r[dateKey].slice(0, 7), traffic: Math.round(num(r[valKey]) || 0) }));
        if (rows.length > best.length) best = rows;
    }));
    return best.sort((a, b) => a.date.localeCompare(b.date));
};

/** Top countries: an array of objects with a country field */
const findCountries = (roots) => {
    let best = [];
    roots.forEach(root => walk(root, (k, v) => {
        if (!Array.isArray(v) || !v.length || !v.every(isPlainObj)) return;
        const cKey = Object.keys(v[0]).find(key => /country/i.test(key) && typeof v[0][key] === 'string');
        if (!cKey) return;
        const keys = Object.keys(v[0]);
        const shareKey = keys.find(key => /share|percent|pct/i.test(key) && num(v[0][key]) !== null);
        const trafficKey = keys.find(key => /traffic|value|visits/i.test(key) && num(v[0][key]) !== null);
        const rows = v.map(r => ({
            country: String(r[cKey] || '').trim(),
            share: shareKey ? num(r[shareKey]) : null,
            traffic: trafficKey ? Math.round(num(r[trafficKey]) || 0) : null,
        })).filter(r => r.country);
        if (rows.length > best.length) best = rows;
    }));
    // Shares given as 0–1 → percent
    if (best.length && best.every(r => r.share === null || r.share <= 1)) best.forEach(r => { if (r.share !== null) r.share = +(r.share * 100).toFixed(2); });
    return best.slice(0, 10);
};

/** A single number under one of the given key patterns (first pattern wins) */
const findNumber = (roots, patterns) => {
    for (const re of patterns) {
        let found = null;
        roots.forEach(root => walk(root, (k, v) => {
            if (found === null && typeof k === 'string' && re.test(k) && num(v) !== null) found = num(v);
        }));
        if (found !== null) return found;
    }
    return null;
};

/**
 * raw = { captures: [{ url, body }], text } from the helper.
 * Ahrefs replies look like ["Ok", {...}] – the array wrapper is unwrapped.
 */
const parse = (raw) => {
    const roots = (raw?.captures || []).map(c => {
        let body = c.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return null; } }
        if (Array.isArray(body) && body[0] === 'Ok') body = body[1];
        return body;
    }).filter(Boolean);

    const history = findHistory(roots);
    const top_countries = findCountries(roots);
    let organic = findNumber(roots, [/^trafficMonthlyAvg$/i, /^organicTraffic$/i, /monthly.*avg/i, /^traffic$/i, /^organic$/i]);
    if (organic === null && history.length) organic = history[history.length - 1].traffic;
    const value = findNumber(roots, [/^costMonthlyAvg$/i, /^costMontlyAvg$/i, /cost/i, /traffic_?value/i]);
    // Ahrefs gives only each country's share – estimate its visits from the total
    if (organic !== null) top_countries.forEach(c => { if (c.traffic === null && c.share !== null) c.traffic = Math.round(organic * c.share / 100); });

    return {
        organic_traffic: organic === null ? null : Math.round(organic),
        traffic_value: value,
        history,
        top_countries,
    };
};

// ─── Read / write ─────────────────────────────────────────────────────

const save = async (siteId, domain, raw, userId) => {
    await ensureSchema();
    const p = parse(raw);
    const r = await query(
        `INSERT INTO site_traffic (site_id, domain, organic_traffic, traffic_value, history, top_countries, raw, checked_by, checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (site_id) DO UPDATE SET domain = EXCLUDED.domain, organic_traffic = EXCLUDED.organic_traffic,
            traffic_value = EXCLUDED.traffic_value, history = EXCLUDED.history, top_countries = EXCLUDED.top_countries,
            raw = EXCLUDED.raw, checked_by = EXCLUDED.checked_by, checked_at = NOW()
         RETURNING site_id, domain, organic_traffic::float8 AS organic_traffic, traffic_value::float8 AS traffic_value, history, top_countries, checked_at`,
        [siteId, domain, p.organic_traffic, p.traffic_value, JSON.stringify(p.history), JSON.stringify(p.top_countries), JSON.stringify(raw), userId]
    );
    return r.rows[0];
};

const get = async (siteId) => {
    await ensureSchema();
    const r = await query(
        `SELECT site_id, domain, organic_traffic::float8 AS organic_traffic, traffic_value::float8 AS traffic_value, history, top_countries, checked_at
         FROM site_traffic WHERE site_id = $1`, [siteId]);
    return r.rows[0] || null;
};

// ─── Check queue (View All Sites buttons) ─────────────────────────────

const RECHECK_MIN_DAYS = 7;
const STATUS_CODES = { Approved: '1', Rejected: '2', Pending: '0' };

/**
 * Next sites for "Check 10 unchecked" / "Re-check 10", over the whole list (not one page).
 *   unchecked: never checked, newest added first
 *   recheck:   last checked more than RECHECK_MIN_DAYS ago, oldest check first – so repeated clicks go through
 *              every site and then start again
 * status = 'Approved' | 'Rejected' | 'Pending' | '' (all) – the list the person is looking at.
 * Returns { sites: [{ id, root_domain }], unchecked, recheck_due, recheck_min_days }
 */
const queue = async ({ type, status, limit = 10 }) => {
    await ensureSchema();
    const { activeSiteSql } = require('./bloggerStatus');
    const params = [];
    const base = [`(ns.delete_site IS NULL OR ns.delete_site = 0)`, activeSiteSql('ns')];
    if (STATUS_CODES[status]) { params.push(STATUS_CODES[status]); base.push(`ns.site_status = $${params.length}`); }
    const where = base.join(' AND ');
    const due = `st.checked_at < NOW() - INTERVAL '${RECHECK_MIN_DAYS} days'`;

    const counts = (await query(
        `SELECT COUNT(*) FILTER (WHERE st.site_id IS NULL) AS unchecked, COUNT(*) FILTER (WHERE ${due}) AS recheck_due
         FROM new_sites ns LEFT JOIN site_traffic st ON st.site_id = ns.id WHERE ${where}`, params)).rows[0];

    let sites = [];
    if (type === 'unchecked' || type === 'recheck') {
        const n = Math.min(25, Math.max(1, parseInt(limit, 10) || 10));
        sites = (await query(
            type === 'unchecked'
                ? `SELECT ns.id, ns.root_domain FROM new_sites ns LEFT JOIN site_traffic st ON st.site_id = ns.id
                   WHERE ${where} AND st.site_id IS NULL AND ns.root_domain IS NOT NULL ORDER BY ns.created_at DESC NULLS LAST, ns.id DESC LIMIT ${n}`
                : `SELECT ns.id, ns.root_domain FROM new_sites ns JOIN site_traffic st ON st.site_id = ns.id
                   WHERE ${where} AND ${due} AND ns.root_domain IS NOT NULL ORDER BY st.checked_at ASC, ns.id LIMIT ${n}`,
            params)).rows;
    }
    return { sites, unchecked: Number(counts.unchecked), recheck_due: Number(counts.recheck_due), recheck_min_days: RECHECK_MIN_DAYS };
};

/** After a parser fix: rebuild every stored check from its raw capture */
const reparseAll = async () => {
    await ensureSchema();
    const rows = (await query(`SELECT site_id, raw FROM site_traffic WHERE raw IS NOT NULL`)).rows;
    for (const row of rows) {
        const p = parse(row.raw);
        await query(
            `UPDATE site_traffic SET organic_traffic = $2, traffic_value = $3, history = $4, top_countries = $5 WHERE site_id = $1`,
            [row.site_id, p.organic_traffic, p.traffic_value, JSON.stringify(p.history), JSON.stringify(p.top_countries)]);
    }
    return rows.length;
};

module.exports = { ensureSchema, parse, save, get, reparseAll, queue, RECHECK_MIN_DAYS };
