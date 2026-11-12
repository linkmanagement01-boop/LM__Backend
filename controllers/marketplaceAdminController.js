/**
 * Admin: Marketplace Pricing (editable price rules per marketplace)
 */

const { query, transaction } = require('../config/database');
const { MARKETPLACES, DEFAULT_MARKETPLACE, RULE_KINDS, ensureSchema, getRules, applyRules, validateRules } = require('../utils/marketplace');
const razorpay = require('../utils/razorpay');
const paypal = require('../utils/paypal');
const { countryName } = require('../utils/countries');

const pickMarketplace = (v) => (MARKETPLACES.includes(v) ? v : DEFAULT_MARKETPLACE);
const EXAMPLE_PRICES = [5, 10, 15, 20, 25, 30, 50, 60, 100, 200];
const pickKind = (v) => (RULE_KINDS.includes(v) ? v : 'normal');
const examplesFor = (rules) => EXAMPLE_PRICES.map(p => ({ blogger_price: p, marketplace_price: applyRules(p, rules) }));

/**
 * @route   GET /api/admin/marketplace/pricing?marketplace=whitelabel
 */
const getPricing = async (req, res, next) => {
    try {
        const marketplace = pickMarketplace(req.query.marketplace);
        const rules = await getRules(marketplace, 'normal');
        const fcRules = await getRules(marketplace, 'fc');
        res.json({
            marketplace,
            marketplaces: MARKETPLACES,
            rules,
            examples: examplesFor(rules),
            // FC prices: used for sites' fc_gp / fc_ne when a client turns FC on
            fc_rules: fcRules,
            fc_examples: examplesFor(fcRules)
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/marketplace/pricing   { marketplace, kind: 'normal' | 'fc', rules: [{min_price, max_price, mode, value}] }
 * @desc    Replace the price rules of a marketplace (takes effect immediately for new prices/orders)
 */
const updatePricing = async (req, res, next) => {
    try {
        await ensureSchema();
        const marketplace = pickMarketplace(req.body.marketplace);
        const kind = pickKind(req.body.kind);
        const rules = (req.body.rules || []).map(r => ({
            min_price: Number(r.min_price),
            max_price: r.max_price === null || r.max_price === '' || r.max_price === undefined ? null : Number(r.max_price),
            mode: r.mode,
            value: Number(r.value)
        }));
        const problem = validateRules(rules);
        if (problem) return res.status(400).json({ error: 'Validation Error', message: problem });

        await transaction(async (client) => {
            await client.query(`DELETE FROM marketplace_price_rules WHERE marketplace = $1 AND kind = $2`, [marketplace, kind]);
            for (const r of rules) {
                await client.query(
                    `INSERT INTO marketplace_price_rules (marketplace, kind, min_price, max_price, mode, value, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
                    [marketplace, kind, r.min_price, r.max_price, r.mode, r.value]
                );
            }
        });
        const saved = await getRules(marketplace, kind);
        res.json({
            message: kind === 'fc' ? 'FC prices saved' : 'Marketplace prices saved',
            marketplace,
            kind,
            rules: saved,
            examples: examplesFor(saved)
        });
    } catch (error) {
        next(error);
    }
};

// ─── Marketplace clients & plans ──────────────────────────────────────
const plans = require('../utils/marketplacePlan');
const planEmails = require('../utils/marketplacePlanEmails');

/**
 * @route GET /api/admin/marketplace/clients?marketplace&search&filter=pro|free|paused&page&limit
 * Marketplace client accounts with their plan, wallet balance (and when it expires), last order and pause date.
 */
const getClients = async (req, res, next) => {
    try {
        await ensureSchema();
        await plans.ensureSchema();
        const marketplace = pickMarketplace(req.query.marketplace);
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        const params = [marketplace];
        let where = `u.role = 'client' AND u.marketplace = $1`;
        if (String(req.query.search || '').trim()) {
            params.push(`%${String(req.query.search).trim()}%`);
            where += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`;
        }
        const filter = String(req.query.filter || '');
        if (filter === 'pro') where += ' AND mp.pro_since IS NOT NULL';
        if (filter === 'free') where += ' AND mp.pro_since IS NULL';
        if (filter === 'paused') where += ' AND mp.deactivated_at IS NOT NULL';
        const from = `FROM users u LEFT JOIN marketplace_plans mp ON mp.client_user_id = u.id WHERE ${where}`;
        const total = parseInt((await query(`SELECT COUNT(*) AS c ${from}`, params)).rows[0].c);
        const rows = (await query(
            `SELECT u.id, u.name, u.email, u.status, u.created_at, u.last_login, u.country_code,
                    COALESCE((SELECT w.balance FROM wallets w WHERE w.user_id = u.id ORDER BY w.id DESC LIMIT 1), 0)::float AS balance,
                    COALESCE((SELECT SUM(cp.amount) FROM client_payments cp WHERE cp.client_user_id = u.id AND cp.status = 'completed'), 0)::float AS topups,
                    (SELECT COUNT(*) FROM marketplace_orders mo WHERE mo.client_user_id = u.id)::int AS orders,
                    mp.pro_since, mp.pro_source, mp.deactivated_at, (mp.pro_since IS NOT NULL) AS pro
             ${from}
             ORDER BY (mp.deactivated_at IS NOT NULL) DESC, (mp.pro_since IS NOT NULL) DESC, u.created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, (page - 1) * limit]
        )).rows;
        // Next money expiry + last order + pause date (worked out per client from the wallet history)
        const clients = await Promise.all(rows.map(async (c) => {
            const plan = await plans.getPlan(c.id);
            return { ...c, country: countryName(c.country_code), last_order_at: plan.last_order_at, deactivates_on: plan.deactivates_on, next_expiry: plan.funds.next_expiry };
        }));
        const stats = (await query(
            `SELECT COUNT(*)::int AS clients,
                    COUNT(*) FILTER (WHERE mp.pro_since IS NOT NULL)::int AS pro,
                    COUNT(*) FILTER (WHERE mp.deactivated_at IS NOT NULL)::int AS paused
             FROM users u LEFT JOIN marketplace_plans mp ON mp.client_user_id = u.id
             WHERE u.role = 'client' AND u.marketplace = $1`, [marketplace]
        )).rows[0];
        res.json({ clients, stats, pro_price: plans.PRO_PRICE, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    } catch (error) {
        next(error);
    }
};

const marketplaceClient = async (id) =>
    (await query(`SELECT id, name, email FROM users WHERE id = $1 AND role = 'client' AND marketplace IS NOT NULL`, [id])).rows[0];

/** @route GET /api/admin/marketplace/clients/:id/plan – plan, wallet money by expiry date and full plan history */
const getClientPlan = async (req, res, next) => {
    try {
        const u = await marketplaceClient(req.params.id);
        if (!u) return res.status(404).json({ error: 'Not Found', message: 'Marketplace client not found' });
        const plan = await plans.getPlan(u.id);
        const history = (await query(
            `SELECT e.kind, e.amount::float AS amount, e.note, e.created_at, a.name AS by_name
             FROM marketplace_plan_events e LEFT JOIN users a ON a.id = e.created_by
             WHERE e.client_user_id = $1 AND e.kind IN ('pro', 'grant', 'expired', 'deactivated', 'reactivated')
             ORDER BY e.created_at DESC LIMIT 100`, [u.id]
        )).rows;
        res.json({ client: u, plan, history });
    } catch (error) {
        next(error);
    }
};

/** @route POST /api/admin/marketplace/clients/:id/grant-pro  { note } – switch Pro on for life */
const grantClientPro = async (req, res, next) => {
    try {
        const u = await marketplaceClient(req.params.id);
        if (!u) return res.status(404).json({ error: 'Not Found', message: 'Marketplace client not found' });
        const note = String(req.body.note || '').trim().slice(0, 300) || `Pro granted by ${req.user.email}`;
        const granted = await transaction(tx => plans.grantPro(tx, u.id, note, req.user.id));
        if (!granted) return res.status(400).json({ error: 'Validation Error', message: 'This client is already on Pro' });
        planEmails.sendPlanEmailTo(u.id, 'pro').catch(() => {});
        res.json({ message: `${u.name || u.email} is now on Pro`, plan: await plans.getPlan(u.id) });
    } catch (error) {
        next(error);
    }
};

/** @route POST /api/admin/marketplace/clients/:id/reactivate  { note } – full access again, 12-month clock restarts */
const reactivateClient = async (req, res, next) => {
    try {
        const u = await marketplaceClient(req.params.id);
        if (!u) return res.status(404).json({ error: 'Not Found', message: 'Marketplace client not found' });
        const note = String(req.body.note || '').trim().slice(0, 300) || `Reactivated by ${req.user.email}`;
        const done = await transaction(tx => plans.reactivate(tx, u.id, note, req.user.id));
        if (!done) return res.status(400).json({ error: 'Validation Error', message: 'This account is not paused' });
        planEmails.sendPlanEmailTo(u.id, 'reactivated').catch(() => {});
        res.json({ message: `${u.name || u.email} is active again`, plan: await plans.getPlan(u.id) });
    } catch (error) {
        next(error);
    }
};

/** @route GET /api/admin/marketplace/free-sites?marketplace – the sites Free users can see and order */
const getFreeSites = async (req, res, next) => {
    try {
        const marketplace = pickMarketplace(req.query.marketplace);
        const domains = await plans.freeDomains(marketplace);
        const found = (await query(
            `SELECT ${plans.domainKeySql('ns')} AS d, BOOL_OR((ns.delete_site IS NULL OR ns.delete_site = 0) AND ns.site_status = '1') AS listed,
                    MAX(ns.dr) AS dr
             FROM new_sites ns WHERE ${plans.domainKeySql('ns')} = ANY($1::text[]) GROUP BY 1`, [domains]
        )).rows;
        const by = new Map(found.map(f => [f.d, f]));
        res.json({
            marketplace,
            sites: domains.map(d => ({ domain: d, in_sites: by.has(d), listed: !!by.get(d)?.listed, dr: by.get(d)?.dr ?? null }))
        });
    } catch (error) {
        next(error);
    }
};

/** @route PUT /api/admin/marketplace/free-sites  { marketplace, domains: [] } – replace the free list */
const updateFreeSites = async (req, res, next) => {
    try {
        await plans.ensureSchema();
        const marketplace = pickMarketplace(req.body.marketplace);
        const list = [...new Set((Array.isArray(req.body.domains) ? req.body.domains : []).map(plans.keyOf).filter(Boolean))];
        if (!list.length) return res.status(400).json({ error: 'Validation Error', message: 'Add at least one free site' });
        if (list.length > 100) return res.status(400).json({ error: 'Validation Error', message: 'Keep the free list to 100 sites or fewer' });
        const invalid = list.filter(d => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
        if (invalid.length) return res.status(400).json({ error: 'Validation Error', message: `Not a domain: ${invalid.join(', ')}` });
        await transaction(async (tx) => {
            await tx.query(`DELETE FROM marketplace_free_sites WHERE marketplace = $1`, [marketplace]);
            for (const [i, d] of list.entries()) {
                await tx.query(`INSERT INTO marketplace_free_sites (marketplace, domain, position) VALUES ($1,$2,$3)`, [marketplace, d, i]);
            }
        });
        req.query.marketplace = marketplace;
        return getFreeSites(req, res, next);
    } catch (error) {
        next(error);
    }
};

// ─── Payments: ₹ rate for Razorpay (India) ─────────────────────────────

const INR_RATE_KEY = 'inr_per_usd';
const FEE_DEFAULTS = { razorpay_gst_pct: 18, razorpay_fee_pct: 2, paypal_fee_pct: 6.5 }; // same as the storefront's defaults

/** @route GET /api/admin/marketplace/payment-settings – ₹ rate + which gateways are set up */
const getPaymentSettings = async (req, res, next) => {
    try {
        await plans.ensureSchema();
        const rows = (await query(`SELECT key, value FROM marketplace_plan_settings WHERE key = ANY($1)`, [[INR_RATE_KEY, ...Object.keys(FEE_DEFAULTS)]])).rows;
        const val = (k) => rows.find(r => r.key === k)?.value;
        const fees = Object.fromEntries(Object.entries(FEE_DEFAULTS).map(([k, d]) => [k, val(k) !== undefined ? Number(val(k)) : d]));
        res.json({
            inr_per_usd: Number(val(INR_RATE_KEY)) || null,
            fees,
            razorpay: { configured: razorpay.isConfigured(), mode: razorpay.mode(), international: razorpay.internationalEnabled(), webhook: !!(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim() },
            paypal: { configured: paypal.isConfigured(), mode: paypal.mode() }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route PUT /api/admin/marketplace/payment-settings  { inr_per_usd?, fees?: { razorpay_gst_pct, razorpay_fee_pct, paypal_fee_pct } }
 * Used for new top-ups from now on.
 */
const updatePaymentSettings = async (req, res, next) => {
    try {
        await plans.ensureSchema();
        const save = (key, value) => query(
            `INSERT INTO marketplace_plan_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, String(value)]);
        const bad = (message) => res.status(400).json({ error: 'Validation Error', message });
        const out = {};
        if (req.body.inr_per_usd !== undefined) {
            const rate = Math.round(Number(req.body.inr_per_usd) * 100) / 100;
            if (!(rate >= 1 && rate <= 1000)) return bad('Please enter a rate between ₹1 and ₹1000 per $1');
            out.inr_per_usd = rate;
        }
        const fees = req.body.fees || {};
        for (const k of Object.keys(FEE_DEFAULTS)) {
            if (fees[k] === undefined) continue;
            const v = Math.round(Number(fees[k]) * 100) / 100;
            if (!(v >= 0 && v <= 50) || fees[k] === '' || fees[k] === null) return bad('Fees must be between 0% and 50%');
            out[k] = v;
        }
        if (!Object.keys(out).length) return bad('Nothing to save');
        for (const [k, v] of Object.entries(out)) await save(k === 'inr_per_usd' ? INR_RATE_KEY : k, v);
        res.json({ message: 'Payment settings saved – used for new top-ups from now on', ...out });
    } catch (error) {
        next(error);
    }
};

module.exports = { getPricing, updatePricing, getClients, getClientPlan, grantClientPro, reactivateClient, getFreeSites, updateFreeSites, getPaymentSettings, updatePaymentSettings };
