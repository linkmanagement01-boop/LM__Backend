/**
 * Site traffic from the Ahrefs free Traffic Checker (see utils/siteTraffic.js).
 * Used by Admin and Manager – View All Sites.
 */

const { query } = require('../config/database');
const siteTraffic = require('../utils/siteTraffic');
const rules = require('../utils/siteTrafficRules');

const MAX_RAW_BYTES = 3 * 1024 * 1024;

/**
 * @route GET /api/admin/sites/:id/traffic  (also /api/manager/sites/:id/traffic)
 * @desc  Last Ahrefs traffic check of a site (null if never checked)
 */
const getSiteTraffic = async (req, res, next) => {
    try {
        res.json({ traffic: await siteTraffic.get(req.params.id) });
    } catch (error) {
        next(error);
    }
};

/**
 * @route POST /api/admin/sites/:id/traffic  (also /api/manager/sites/:id/traffic)
 * @body  { captures: [{ url, body }], text }  – sent by the LM Traffic Helper extension
 */
const saveSiteTraffic = async (req, res, next) => {
    try {
        const site = (await query(`SELECT id, root_domain FROM new_sites WHERE id = $1`, [req.params.id])).rows[0];
        if (!site) return res.status(404).json({ message: 'Site not found' });

        const captures = Array.isArray(req.body.captures) ? req.body.captures.slice(0, 20).map(c => ({
            url: String(c?.url || '').slice(0, 500),
            body: c?.body,
        })) : [];
        const raw = { captures, text: String(req.body.text || '').slice(0, 20000) };
        if (Buffer.byteLength(JSON.stringify(raw)) > MAX_RAW_BYTES) return res.status(413).json({ message: 'Traffic data is too large' });
        if (!captures.length) return res.status(400).json({ message: 'No traffic data was captured from Ahrefs' });

        const saved = await siteTraffic.save(site.id, site.root_domain, raw, req.user.id);
        // Approved + low traffic → rejected; rejected + growing → Suggestions
        const rule = await rules.applyRules(site.id, saved, req.user.id);
        const traffic = { ...saved, ...rule, rule_resolved: null };
        const found = saved.organic_traffic !== null || saved.history.length || saved.top_countries.length;
        const message = !found ? 'Saved, but no traffic numbers were found in the Ahrefs data'
            : rule.rule_action === 'auto_rejected' ? `Traffic saved – site rejected (${rules.AUTO_REJECT_MAX} or less)`
            : rule.rule_action === 'suggested' ? 'Traffic saved – growing, added to Suggestions'
            : 'Traffic saved';
        res.json({ traffic, message });
    } catch (error) {
        next(error);
    }
};

/**
 * @route GET /api/admin/sites/traffic-suggestions?tab=suggested|auto_rejected  (also /api/manager/...)
 * @desc  Suggestions page: rejected sites that are growing, and sites the rules auto-rejected
 */
const getTrafficSuggestions = async (req, res, next) => {
    try {
        const [sites, counts] = await Promise.all([rules.list(req.query.tab), rules.counts()]);
        res.json({ sites, counts, rules: { auto_reject_max: rules.AUTO_REJECT_MAX, suggest_min: rules.SUGGEST_MIN, growth_min_pct: rules.GROWTH_MIN_PCT } });
    } catch (error) {
        next(error);
    }
};

/** @route GET /api/admin/sites/traffic-suggestions/counts  (also /api/manager/...) – sidebar badge */
const getTrafficSuggestionCounts = async (req, res, next) => {
    try {
        res.json(await rules.counts());
    } catch (error) {
        next(error);
    }
};

/**
 * @route POST /api/admin/sites/:id/traffic-decision  (also /api/manager/...)
 * @body  { decision: 'activate' | 'keep' | 'undo' | 'confirm' }
 */
const decideTrafficSuggestion = async (req, res, next) => {
    try {
        const r = await rules.decide(req.params.id, req.body.decision, req.user.id);
        if (r.error) return res.status(r.status).json({ message: r.error });
        res.json({ ...r, counts: await rules.counts() });
    } catch (error) {
        next(error);
    }
};

/**
 * @route GET /api/admin/sites/traffic-queue?type=unchecked|recheck&status=Approved&limit=10  (also /api/manager/...)
 * @desc  Next sites for "Check 10 unchecked" / "Re-check 10" across the whole list; without type only the counts.
 *        Managers always get approved sites (their View All Sites list).
 */
const getTrafficQueue = async (req, res, next) => {
    try {
        const status = req.user.role?.toLowerCase() === 'manager' ? 'Approved' : String(req.query.status || '');
        res.json(await siteTraffic.queue({ type: req.query.type, status, limit: req.query.limit }));
    } catch (error) {
        next(error);
    }
};

module.exports = { getSiteTraffic, saveSiteTraffic, getTrafficSuggestions, getTrafficSuggestionCounts, decideTrafficSuggestion, getTrafficQueue };
