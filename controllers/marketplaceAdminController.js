/**
 * Admin: Marketplace Pricing (editable price rules per marketplace)
 */

const { query, transaction } = require('../config/database');
const { MARKETPLACES, DEFAULT_MARKETPLACE, ensureSchema, getRules, applyRules, validateRules } = require('../utils/marketplace');

const pickMarketplace = (v) => (MARKETPLACES.includes(v) ? v : DEFAULT_MARKETPLACE);
const EXAMPLE_PRICES = [5, 10, 15, 20, 25, 30, 50, 60, 100, 200];

/**
 * @route   GET /api/admin/marketplace/pricing?marketplace=whitelabel
 */
const getPricing = async (req, res, next) => {
    try {
        const marketplace = pickMarketplace(req.query.marketplace);
        const rules = await getRules(marketplace);
        res.json({
            marketplace,
            marketplaces: MARKETPLACES,
            rules,
            examples: EXAMPLE_PRICES.map(p => ({ blogger_price: p, marketplace_price: applyRules(p, rules) }))
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/marketplace/pricing   { marketplace, rules: [{min_price, max_price, mode, value}] }
 * @desc    Replace the price rules of a marketplace (takes effect immediately for new prices/orders)
 */
const updatePricing = async (req, res, next) => {
    try {
        await ensureSchema();
        const marketplace = pickMarketplace(req.body.marketplace);
        const rules = (req.body.rules || []).map(r => ({
            min_price: Number(r.min_price),
            max_price: r.max_price === null || r.max_price === '' || r.max_price === undefined ? null : Number(r.max_price),
            mode: r.mode,
            value: Number(r.value)
        }));
        const problem = validateRules(rules);
        if (problem) return res.status(400).json({ error: 'Validation Error', message: problem });

        await transaction(async (client) => {
            await client.query(`DELETE FROM marketplace_price_rules WHERE marketplace = $1`, [marketplace]);
            for (const r of rules) {
                await client.query(
                    `INSERT INTO marketplace_price_rules (marketplace, min_price, max_price, mode, value, updated_at)
                     VALUES ($1,$2,$3,$4,$5,NOW())`,
                    [marketplace, r.min_price, r.max_price, r.mode, r.value]
                );
            }
        });
        const saved = await getRules(marketplace);
        res.json({
            message: 'Marketplace prices saved',
            marketplace,
            rules: saved,
            examples: EXAMPLE_PRICES.map(p => ({ blogger_price: p, marketplace_price: applyRules(p, saved) }))
        });
    } catch (error) {
        next(error);
    }
};

module.exports = { getPricing, updatePricing };
