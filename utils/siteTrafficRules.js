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
    return r.rows;
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

module.exports = { AUTO_REJECT_MAX, SUGGEST_MIN, GROWTH_MIN_PCT, growth, applyRules, counts, list, decide };
