/**
 * Site status rules, run every time a site's Ahrefs traffic is saved (single or bulk check):
 *   - Approved site (site_status '1') with organic traffic ≤ AUTO_REJECT_MAX  → automatically Rejected ('2')
 *   - Rejected site with traffic ≥ SUGGEST_MIN and growing                     → Suggestions page (a manager decides)
 * Pending sites are never touched, and a check without a traffic number does nothing.
 *
 * Growing = average of the last 3 months ≥ GROWTH_MIN_PCT % above the 3 months before, and the latest month
 * is not below the previous one.
 *
 * The result is kept on site_traffic (rule_action / rule_resolved) and every step is logged in site_traffic_log.
 */

const { query } = require('../config/database');
const { ensureSchema } = require('./siteTraffic');

const AUTO_REJECT_MAX = 200;
const SUGGEST_MIN = 500;
const GROWTH_MIN_PCT = 10;

const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/** { growing, pct } from the monthly history (oldest first). Needs at least 4 months. */
const growth = (history = []) => {
    const vals = history.map(h => Number(h.traffic) || 0);
    if (vals.length < 4) return { growing: false, pct: null };
    const n = Math.min(3, Math.floor(vals.length / 2));
    const last = vals.slice(-n), prev = vals.slice(-2 * n, -n);
    const a = avg(last), b = avg(prev);
    const pct = b > 0 ? ((a - b) / b) * 100 : (a > 0 ? 999 : 0);
    const notFalling = vals[vals.length - 1] >= vals[vals.length - 2];
    return { growing: pct >= GROWTH_MIN_PCT && notFalling, pct: Math.round(Math.min(pct, 999) * 100) / 100 };
};

const log = (siteId, action, organic, pct, userId) => query(
    `INSERT INTO site_traffic_log (site_id, action, organic_traffic, growth_pct, user_id) VALUES ($1,$2,$3,$4,$5)`,
    [siteId, action, organic, pct, userId]);

/**
 * After a check was saved. traffic = the saved site_traffic row.
 * Returns { rule_action: 'auto_rejected' | 'suggested' | null, site_status, growth_pct }
 */
const applyRules = async (siteId, traffic, userId) => {
    await ensureSchema();
    const site = (await query(`SELECT site_status FROM new_sites WHERE id = $1`, [siteId])).rows[0];
    const organic = traffic.organic_traffic === null || traffic.organic_traffic === undefined ? null : Number(traffic.organic_traffic);
    const g = growth(traffic.history);
    await query(`UPDATE site_traffic SET growth_pct = $2 WHERE site_id = $1`, [siteId, g.pct]);
    if (!site || organic === null) return { rule_action: null, site_status: site?.site_status ?? null, growth_pct: g.pct };

    let action = null;
    if (site.site_status === '1' && organic <= AUTO_REJECT_MAX) {
        await query(`UPDATE new_sites SET site_status = '2', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [siteId]);
        action = 'auto_rejected';
    } else if (site.site_status === '2' && organic >= SUGGEST_MIN && g.growing) {
        action = 'suggested';
    }

    if (action) {
        await query(
            `UPDATE site_traffic SET rule_action = $2, rule_at = NOW(), rule_resolved = NULL, resolved_by = NULL, resolved_at = NULL WHERE site_id = $1`,
            [siteId, action]);
        await log(siteId, action, organic, g.pct, userId);
    } else {
        // An open suggestion that no longer qualifies leaves the Suggestions page (an auto-rejection stays until handled)
        await query(
            `UPDATE site_traffic SET rule_resolved = 'expired', resolved_at = NOW()
             WHERE site_id = $1 AND rule_action = 'suggested' AND rule_resolved IS NULL`, [siteId]);
    }
    const now = (await query(`SELECT site_status FROM new_sites WHERE id = $1`, [siteId])).rows[0];
    return { rule_action: action, site_status: now.site_status, growth_pct: g.pct };
};

// Open items: still waiting for a manager, and the site is still rejected
const OPEN_SQL = `st.rule_resolved IS NULL AND ns.site_status = '2' AND (ns.delete_site IS NULL OR ns.delete_site = 0)`;

const counts = async () => {
    await ensureSchema();
    const r = await query(
        `SELECT COUNT(*) FILTER (WHERE st.rule_action = 'suggested') AS suggested,
                COUNT(*) FILTER (WHERE st.rule_action = 'auto_rejected') AS auto_rejected
         FROM site_traffic st JOIN new_sites ns ON ns.id = st.site_id WHERE ${OPEN_SQL}`);
    return { suggested: Number(r.rows[0].suggested), auto_rejected: Number(r.rows[0].auto_rejected) };
};

/** tab = 'suggested' | 'auto_rejected' – fields match the View All Sites list (ahrefs_* included) */
const list = async (tab) => {
    await ensureSchema();
    const action = tab === 'auto_rejected' ? 'auto_rejected' : 'suggested';
    const r = await query(
        `SELECT ns.id, ns.root_domain, ns.category, ns.da, ns.dr, ns.rd, ns.spam_score, ns.traffic_source AS traffic,
                ns.gp_price, ns.niche_edit_price, ns.fc_gp, ns.fc_ne, ns.email, ns.site_status, ns.website_status, ns.created_at,
                st.organic_traffic::float8 AS ahrefs_traffic, st.checked_at AS ahrefs_checked_at,
                st.traffic_value::float8 AS ahrefs_value, st.history AS ahrefs_history, st.top_countries AS ahrefs_countries,
                st.growth_pct::float8 AS growth_pct, st.rule_action AS ahrefs_rule, st.rule_at
         FROM site_traffic st JOIN new_sites ns ON ns.id = st.site_id
         WHERE st.rule_action = $1 AND ${OPEN_SQL}
         ORDER BY ${action === 'suggested' ? 'st.organic_traffic DESC' : 'st.rule_at DESC'}`, [action]);
    return withHistory(r.rows);
};

// "www.Site.com/" and "https://site.com" are the same domain
const KEY_SQL = (a) => `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(${a}.root_domain), '^https?://', '', 'i'), '^www\\.', '', 'i'), '/.*$', ''))`;
const keyOf = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

/**
 * Adds to every listed site what a manager checks before deciding:
 *   duplicates – other rows in Sites with the same domain (status, prices, blogger, Ahrefs traffic)
 *   rejected_orders – order lines on this domain (any copy) that were rejected by a manager or refused by the blogger
 *                     (same rule as Manager → Rejected Orders → Bloggers, plus blogger refusals)
 */
const withHistory = async (sites) => {
    if (!sites.length) return sites;
    const keys = [...new Set(sites.map(s => keyOf(s.root_domain)))];
    const [dups, rejected] = await Promise.all([
        query(
            `SELECT ns.id, ns.root_domain, ${KEY_SQL('ns')} AS key, ns.site_status, ns.gp_price, ns.niche_edit_price, ns.fc_gp, ns.fc_ne,
                    ns.email, ns.created_at, (ns.delete_site = 1) AS deleted, u.name AS blogger_name, u.email AS blogger_email,
                    st.organic_traffic::float8 AS ahrefs_traffic, st.checked_at AS ahrefs_checked_at
             FROM new_sites ns
             LEFT JOIN users u ON u.id = ns.uploaded_user_id
             LEFT JOIN site_traffic st ON st.site_id = ns.id
             WHERE ${KEY_SQL('ns')} = ANY($1::text[])
             ORDER BY ns.created_at`, [keys]),
        query(
            `SELECT nopd.id AS line_id, o.id AS order_pk, o.order_id, o.order_type, ${KEY_SQL('ns')} AS key, ns.id AS site_id,
                    nopd.status, nopd.reject_reason, nopd.updated_at, u.name AS blogger_name, u.email AS blogger_email
             FROM new_order_process_details nopd
             JOIN new_order_processes nop ON nop.id = nopd.new_order_process_id
             JOIN new_orders o ON o.id = nop.new_order_id
             JOIN new_sites ns ON ns.id = nopd.new_site_id
             LEFT JOIN users u ON u.id = nopd.vendor_id
             WHERE ${KEY_SQL('ns')} = ANY($1::text[])
               AND (nopd.status IN (11, 12) OR (nopd.reject_reason IS NOT NULL AND TRIM(nopd.reject_reason) <> ''))
               AND o.order_id NOT LIKE 'CLT-%'
             ORDER BY nopd.updated_at DESC`, [keys])
    ]);
    const STATUS = { 1: 'Approved', 2: 'Rejected', 0: 'Pending' };
    return sites.map(s => {
        const key = keyOf(s.root_domain);
        return {
            ...s,
            duplicates: dups.rows.filter(d => d.key === key && String(d.id) !== String(s.id)).map(d => ({
                id: d.id, root_domain: d.root_domain, status: d.deleted ? 'Deleted' : (STATUS[d.site_status] || 'Pending'),
                gp_price: d.gp_price, niche_edit_price: d.niche_edit_price, fc_gp: d.fc_gp, fc_ne: d.fc_ne,
                email: d.email, blogger_name: d.blogger_name, blogger_email: d.blogger_email, created_at: d.created_at,
                ahrefs_traffic: d.ahrefs_traffic, ahrefs_checked_at: d.ahrefs_checked_at
            })),
            rejected_orders: rejected.rows.filter(r => r.key === key).slice(0, 25).map(r => ({
                line_id: r.line_id, order_pk: r.order_pk, order_id: r.order_id, order_type: r.order_type,
                site_id: r.site_id, same_site: String(r.site_id) === String(s.id),
                // 11 = rejected by a manager, 12 = refused by the blogger; other statuses = a reason left from an earlier rejection
                by: Number(r.status) === 12 ? 'blogger' : 'manager',
                status: Number(r.status), reason: (r.reject_reason || '').trim(), date: r.updated_at,
                blogger_name: r.blogger_name, blogger_email: r.blogger_email
            })),
            rejected_orders_total: rejected.rows.filter(r => r.key === key).length
        };
    });
};

/**
 * A manager's decision.
 *   suggested:      activate (→ Approved) | keep (stays Rejected)
 *   auto_rejected:  undo (→ Approved)     | confirm (stays Rejected)
 */
const DECISIONS = { activate: ['suggested', 'activated', '1'], keep: ['suggested', 'kept', null], undo: ['auto_rejected', 'undone', '1'], confirm: ['auto_rejected', 'confirmed', null] };

const decide = async (siteId, decision, userId) => {
    await ensureSchema();
    const d = DECISIONS[decision];
    if (!d) return { error: 'Unknown decision', status: 400 };
    const [needAction, resolved, newStatus] = d;
    const row = (await query(
        `SELECT st.rule_action, st.organic_traffic, st.growth_pct FROM site_traffic st JOIN new_sites ns ON ns.id = st.site_id
         WHERE st.site_id = $1 AND ${OPEN_SQL}`, [siteId])).rows[0];
    if (!row || row.rule_action !== needAction) return { error: 'This site is no longer waiting for a decision', status: 409 };

    if (newStatus) await query(`UPDATE new_sites SET site_status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [siteId, newStatus]);
    await query(`UPDATE site_traffic SET rule_resolved = $2, resolved_by = $3, resolved_at = NOW() WHERE site_id = $1`, [siteId, resolved, userId]);
    await log(siteId, resolved, row.organic_traffic, row.growth_pct, userId);
    return { ok: true, site_status: newStatus || '2' };
};

module.exports = { withHistory, AUTO_REJECT_MAX, SUGGEST_MIN, GROWTH_MIN_PCT, growth, applyRules, counts, list, decide };
