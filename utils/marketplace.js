/**
 * Marketplace core (white-label first; India / International later)
 *
 * - Tables are created automatically (no manual migration).
 * - Prices: each marketplace has admin-editable rules "blogger price range → marketplace price"
 *   (a rule can be a fixed price or a % increase). Applied separately to a site's GP and NE price.
 * - The marketplace never exposes blogger details or internal prices.
 */

const { query } = require('../config/database');

const MARKETPLACES = ['whitelabel']; // later: 'india', 'international'
const DEFAULT_MARKETPLACE = 'whitelabel';
const RULE_KINDS = ['normal', 'fc'];

// Starting tiers (admin can change them on Admin → Marketplace Pricing)
const DEFAULT_RULES = [
    { min_price: 0, max_price: 15, mode: 'fixed', value: 30 },
    { min_price: 15.01, max_price: 25, mode: 'fixed', value: 40 },
    { min_price: 25.01, max_price: 50, mode: 'fixed', value: 70 },
    { min_price: 50.01, max_price: null, mode: 'percent', value: 40 }
];

let schemaReady = null;
const ensureSchema = () => (schemaReady = schemaReady || (async () => {
    // Which marketplace a client account belongs to (NULL = internal client area)
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS marketplace VARCHAR(30)`);

    await query(`
        CREATE TABLE IF NOT EXISTS marketplace_price_rules (
            id SERIAL PRIMARY KEY,
            marketplace VARCHAR(30) NOT NULL,
            min_price NUMERIC NOT NULL DEFAULT 0,
            max_price NUMERIC,                 -- NULL = no upper limit
            mode VARCHAR(10) NOT NULL DEFAULT 'fixed', -- 'fixed' = set price, 'percent' = increase by %
            value NUMERIC NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);

    // Signups waiting for their email code (kept apart from blogger signups)
    await query(`
        CREATE TABLE IF NOT EXISTS marketplace_pending_signups (
            id SERIAL PRIMARY KEY,
            marketplace VARCHAR(30) NOT NULL,
            email VARCHAR(255) NOT NULL,
            name VARCHAR(255),
            password_hash TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            attempts INT NOT NULL DEFAULT 0,
            expires_at TIMESTAMPTZ NOT NULL,
            last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS marketplace_pending_signups_email_uq ON marketplace_pending_signups (LOWER(email))`);

    // Cart: one row per site + type (a site can be in the cart once as GP and once as NE)
    await query(`
        CREATE TABLE IF NOT EXISTS marketplace_cart_items (
            id SERIAL PRIMARY KEY,
            client_user_id INT NOT NULL,
            site_id INT NOT NULL,
            order_type VARCHAR(20) NOT NULL,   -- 'Guest Post' | 'Niche Edit'
            anchor_text TEXT NOT NULL,
            target_url TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS marketplace_cart_items_uq ON marketplace_cart_items (client_user_id, site_id, order_type)`);
    // Guest Post content (client file/link or our writing brief) + Niche Edit chosen post
    await query(`
        ALTER TABLE marketplace_cart_items
            ADD COLUMN IF NOT EXISTS content_by VARCHAR(10),        -- GP: 'client' | 'us'
            ADD COLUMN IF NOT EXISTS doc_url TEXT,                  -- GP client: uploaded file or Google Doc link
            ADD COLUMN IF NOT EXISTS doc_name TEXT,
            ADD COLUMN IF NOT EXISTS reference_url TEXT,
            ADD COLUMN IF NOT EXISTS title_suggestion TEXT,         -- GP us: writing brief
            ADD COLUMN IF NOT EXISTS word_count INT,
            ADD COLUMN IF NOT EXISTS category TEXT,
            ADD COLUMN IF NOT EXISTS keywords TEXT,
            ADD COLUMN IF NOT EXISTS target_country TEXT,
            ADD COLUMN IF NOT EXISTS note TEXT,
            ADD COLUMN IF NOT EXISTS post_url TEXT,                 -- NE: existing post the link goes into
            ADD COLUMN IF NOT EXISTS post_title TEXT`);
    // Client orders sent to a writer mark which sites the writer must work on (no default: older rows stay NULL = shown)
    await query(`ALTER TABLE new_order_process_details ADD COLUMN IF NOT EXISTS fill_details BOOLEAN`);
    // The same details on the team's order rows
    await query(`
        ALTER TABLE client_order_details
            ADD COLUMN IF NOT EXISTS content_by VARCHAR(10),
            ADD COLUMN IF NOT EXISTS brief JSONB`);

    // One marketplace order = what the client sees; behind it one client_order per type for the team
    await query(`
        CREATE TABLE IF NOT EXISTS marketplace_orders (
            id SERIAL PRIMARY KEY,
            marketplace VARCHAR(30) NOT NULL,
            client_user_id INT NOT NULL,
            order_number VARCHAR(40) NOT NULL UNIQUE,
            total_price NUMERIC NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await query(`ALTER TABLE client_orders ADD COLUMN IF NOT EXISTS marketplace VARCHAR(30)`);
    await query(`ALTER TABLE client_orders ADD COLUMN IF NOT EXISTS marketplace_order_id INT`);

    // PayPal top-ups reuse client_payments
    await query(`ALTER TABLE client_payments ADD COLUMN IF NOT EXISTS provider VARCHAR(20)`);
    await query(`ALTER TABLE client_payments ADD COLUMN IF NOT EXISTS paypal_order_id VARCHAR(64)`);
    await query(`ALTER TABLE client_payments ADD COLUMN IF NOT EXISTS paypal_capture_id VARCHAR(64)`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS client_payments_paypal_order_uq ON client_payments (paypal_order_id) WHERE paypal_order_id IS NOT NULL`);

    // Two rule sets per marketplace: normal prices and FC prices (sites' fc_gp / fc_ne)
    await query(`ALTER TABLE marketplace_price_rules ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'normal'`);
    // FC orders: the cart line and the team's order remember that FC prices apply
    await query(`ALTER TABLE marketplace_cart_items ADD COLUMN IF NOT EXISTS fc BOOLEAN NOT NULL DEFAULT false`);
    await query(`DROP INDEX IF EXISTS marketplace_cart_items_uq`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS marketplace_cart_items_fc_uq ON marketplace_cart_items (client_user_id, site_id, order_type, fc)`);
    await query(`ALTER TABLE client_orders ADD COLUMN IF NOT EXISTS fc INT NOT NULL DEFAULT 0`);

    // Seed the starting price tiers once per marketplace and kind (FC starts with the same tiers)
    for (const mp of MARKETPLACES) {
        for (const kind of RULE_KINDS) {
            const has = (await query(`SELECT 1 FROM marketplace_price_rules WHERE marketplace = $1 AND kind = $2 LIMIT 1`, [mp, kind])).rows.length;
            if (!has) {
                for (const r of DEFAULT_RULES) {
                    await query(
                        `INSERT INTO marketplace_price_rules (marketplace, kind, min_price, max_price, mode, value) VALUES ($1,$2,$3,$4,$5,$6)`,
                        [mp, kind, r.min_price, r.max_price, r.mode, r.value]
                    );
                }
            }
        }
    }
})().catch(err => { schemaReady = null; throw err; }));

// ─── Pricing ──────────────────────────────────────────────────────────
/** Price rules of one marketplace; kind 'normal' (gp_price / niche_edit_price) or 'fc' (fc_gp / fc_ne) */
const getRules = async (marketplace, kind = 'normal') => {
    await ensureSchema();
    return (await query(
        `SELECT id, min_price::float AS min_price, max_price::float AS max_price, mode, value::float AS value
         FROM marketplace_price_rules WHERE marketplace = $1 AND kind = $2 ORDER BY min_price ASC`,
        [marketplace, RULE_KINDS.includes(kind) ? kind : 'normal']
    )).rows;
};

/** Blogger price columns for normal or FC orders */
const priceColumns = (fc) => (fc ? { gp: 'fc_gp', ne: 'fc_ne' } : { gp: 'gp_price', ne: 'niche_edit_price' });

/** Blogger price text ("$15", "N/A", "0") → number, or null when not sellable */
const parsePrice = (v) => {
    const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
};

/** Marketplace price for one blogger price, using the given rules (null = not for sale) */
const applyRules = (bloggerPrice, rules) => {
    const p = parsePrice(bloggerPrice);
    if (p === null) return null;
    const rule = rules.find(r => p >= r.min_price && (r.max_price === null || p <= r.max_price))
        || rules[rules.length - 1];
    if (!rule) return null;
    const price = rule.mode === 'percent' ? p * (1 + rule.value / 100) : rule.value;
    return Math.round(price * 100) / 100;
};

/** Check a rules list sent by the admin; returns an error message or null */
const validateRules = (rules) => {
    if (!Array.isArray(rules) || rules.length === 0) return 'Add at least one price rule';
    for (const [i, r] of rules.entries()) {
        const row = `Row ${i + 1}`;
        if (!(Number(r.min_price) >= 0)) return `${row}: "From" must be 0 or more`;
        if (r.max_price !== null && r.max_price !== '' && !(Number(r.max_price) >= Number(r.min_price))) return `${row}: "To" must be empty or at least "From"`;
        if (!['fixed', 'percent'].includes(r.mode)) return `${row}: choose "Fixed price" or "Increase by %"`;
        if (!(Number(r.value) > 0)) return `${row}: the value must be more than 0`;
    }
    return null;
};

/**
 * SQL expression for the marketplace price of a blogger price column (NULL = not for sale),
 * so the site list can filter and sort by the price the client actually sees.
 * Rule numbers come from our own table and are inlined as numbers.
 */
const priceSql = (col, rules) => {
    const cleaned = `REGEXP_REPLACE(COALESCE(${col}::text, ''), '[^0-9.]', '', 'g')`;
    const p = `(CASE WHEN ${cleaned} ~ '^[0-9]+(\\.[0-9]+)?$' AND ${cleaned}::numeric > 0 THEN ${cleaned}::numeric END)`;
    if (!rules.length) return 'NULL::numeric';
    const branch = (r) => (r.mode === 'percent' ? `ROUND(${p} * ${1 + Number(r.value) / 100}, 2)` : `${Number(r.value)}`);
    const whens = rules.map(r => `WHEN ${p} >= ${Number(r.min_price)}${r.max_price === null ? '' : ` AND ${p} <= ${Number(r.max_price)}`} THEN ${branch(r)}`);
    return `(CASE WHEN ${p} IS NULL THEN NULL ${whens.join(' ')} ELSE ${branch(rules[rules.length - 1])} END)`;
};

/** Brand used in a marketplace's emails (set the name/URL once the marketplace name is decided) */
const getBrand = (marketplace = DEFAULT_MARKETPLACE) => {
    const key = marketplace.toUpperCase();
    const name = process.env[`MARKETPLACE_${key}_NAME`] || 'Link Marketplace';
    return {
        name,
        site: name,
        url: process.env[`MARKETPLACE_${key}_URL`] || 'http://localhost:5175',
        tagline: process.env[`MARKETPLACE_${key}_TAGLINE`] || 'Quality links, delivered',
        fromEmail: process.env[`MARKETPLACE_${key}_FROM_EMAIL`] || undefined
    };
};

module.exports = {
    MARKETPLACES, DEFAULT_MARKETPLACE, RULE_KINDS, ensureSchema, getRules, priceColumns, applyRules, parsePrice, validateRules, priceSql, getBrand
};
