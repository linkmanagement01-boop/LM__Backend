/**
 * Marketplace plans (Free / Pro) + wallet money that expires.
 *
 *  - Free: 20 free sites (list in marketplace_free_sites) fully visible + orderable; other sites masked, page 1 only.
 *    Free clients are never deactivated.
 *  - Pro: ONE top-up of $499 or more (smaller top-ups never add up). Pro is for life – it never goes back to Free.
 *    Admins can also grant Pro by hand. Nothing is charged for the plan: the money stays in the wallet for orders.
 *  - Every credit to the wallet (top-up, admin credit) is a "lot" valid for 12 months from the day it was added.
 *    Orders spend the oldest lot first. A refund goes back to the lot(s) the order was paid from (original expiry).
 *    Money added before this went live is valid for 12 months from the launch day (EXPIRY_START setting).
 *  - A Pro client with no order for 12 months (from the last order, Pro start or reactivation) is deactivated:
 *    they can still log in, but only Support works until an admin reactivates them. Never while an order is open.
 *
 * The lots are worked out from wallet_histories (the single source of truth), so every way money moves
 * (top-ups, admin credits/debits, manager or blogger refunds) is covered without extra bookkeeping.
 */

const { query } = require('../config/database');
const mp = require('./marketplace');

const PRO_PRICE = 499;
const VALID_MONTHS = 12;        // wallet money is valid this long
const INACTIVE_MONTHS = 12;     // Pro clients are deactivated after this long without an order
const REMIND_DAYS = [30, 7, 1]; // warning emails before money expires / the account is deactivated
const EXPIRED_REMARK = 'Expired funds';

const FREE_SITES = [
    'bulkdp.com', 'notejaar.com', 'dailymagzines.co.uk', 'webkhoj.com', 'whataburgersmenu.us', 'plugboxlinux.net',
    'sheend.net', 'knowledgar.com', 'sonicmenuusa.com', 'piksart.one', 'influencegonewild.com', 'allexamreview.com',
    'animeshow.io', 'radiofueguina.com', 'factspodium.com', 'theartisticmind.com', 'indiehackers.com',
    'elevatedmagazines.com', 'instander-official.com', 'inat-box-apk.com.tr'
];

/** SQL: a new_sites row's domain as a plain key ("https://www.ABC.com" → "abc.com") */
const domainKeySql = (alias = 'ns') => `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(${alias}.root_domain), '^https?://', ''), '^www\\.', ''))`;
const keyOf = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

const addMonths = (date, months) => {
    const d = new Date(date);
    d.setMonth(d.getMonth() + months);
    return d;
};
const cents = (v) => Math.round(Number(v || 0) * 100);

let schemaReady = null;
const ensureSchema = () => (schemaReady = schemaReady || (async () => {
    await query(`
        CREATE TABLE IF NOT EXISTS marketplace_plans (
            client_user_id INT PRIMARY KEY,
            plan VARCHAR(10),
            pro_until TIMESTAMPTZ,
            progress NUMERIC(10,2) NOT NULL DEFAULT 0,
            reminded_for TIMESTAMPTZ,
            expired_for TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    // Lifetime Pro + deactivation (plan / pro_until / progress / reminded_for / expired_for are from the old monthly model, unused)
    await query(`ALTER TABLE marketplace_plans ADD COLUMN IF NOT EXISTS pro_since TIMESTAMPTZ`);         // Pro from here, for life
    await query(`ALTER TABLE marketplace_plans ADD COLUMN IF NOT EXISTS pro_source VARCHAR(10)`);        // topup | admin
    await query(`ALTER TABLE marketplace_plans ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ`);    // set = only Support works
    await query(`ALTER TABLE marketplace_plans ADD COLUMN IF NOT EXISTS reactivated_at TIMESTAMPTZ`);    // restarts the 12-month clock
    await query(`ALTER TABLE marketplace_plans ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ`);
    await query(`
        CREATE TABLE IF NOT EXISTS marketplace_plan_events (
            id SERIAL PRIMARY KEY,
            client_user_id INT NOT NULL,
            kind VARCHAR(20) NOT NULL,                -- pro | grant | expired | deactivated | reactivated
            amount NUMERIC(10,2),
            days_added INT NOT NULL DEFAULT 0,
            pro_until_after TIMESTAMPTZ,
            note TEXT,
            created_by INT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await query(`CREATE INDEX IF NOT EXISTS marketplace_plan_events_client_idx ON marketplace_plan_events (client_user_id, created_at DESC)`);
    // Warning emails already sent (one row per lot / deadline and day count)
    await query(`
        CREATE TABLE IF NOT EXISTS marketplace_plan_reminders (
            client_user_id INT NOT NULL,
            key VARCHAR(80) NOT NULL,
            sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (client_user_id, key)
        )`);
    await query(`CREATE TABLE IF NOT EXISTS marketplace_plan_settings (key VARCHAR(40) PRIMARY KEY, value TEXT)`);
    // Launch day of expiring money: older balances get 12 months from here
    await query(`INSERT INTO marketplace_plan_settings (key, value) VALUES ('expiry_start', $1) ON CONFLICT DO NOTHING`, [new Date().toISOString()]);
    await query(`
        CREATE TABLE IF NOT EXISTS marketplace_free_sites (
            marketplace VARCHAR(30) NOT NULL,
            domain VARCHAR(255) NOT NULL,
            position INT NOT NULL DEFAULT 0,
            PRIMARY KEY (marketplace, domain)
        )`);
    // Seed the free list once per marketplace (admin can change it later)
    const has = (await query(`SELECT 1 FROM marketplace_free_sites WHERE marketplace = 'whitelabel' LIMIT 1`)).rows.length;
    if (!has) {
        for (const [i, d] of FREE_SITES.entries()) {
            await query(`INSERT INTO marketplace_free_sites (marketplace, domain, position) VALUES ('whitelabel', $1, $2) ON CONFLICT DO NOTHING`, [d, i]);
        }
    }
})().catch(err => { schemaReady = null; throw err; }));

let expiryStart = null;
const getExpiryStart = async () => {
    if (!expiryStart) {
        await ensureSchema();
        const v = (await query(`SELECT value FROM marketplace_plan_settings WHERE key = 'expiry_start'`)).rows[0]?.value;
        expiryStart = v ? new Date(v) : new Date();
    }
    return expiryStart;
};

/** Tests only: pretend the expiry rule started on another day (this process only) */
const setExpiryStartForTests = (d) => { expiryStart = new Date(d); };

/** Free site domains (keys) of a marketplace */
const freeDomains = async (marketplace) => {
    await ensureSchema();
    return (await query(`SELECT domain FROM marketplace_free_sites WHERE marketplace = $1 ORDER BY position, domain`, [marketplace])).rows.map(r => r.domain);
};

// ─── Wallet lots ──────────────────────────────────────────────────────

const ORDER_REF = /MP-\d{8}-[0-9A-F]{6}/i;
const isRefund = (remarks) => /^\s*refund/i.test(remarks || '');
const isExpiry = (remarks) => String(remarks || '').startsWith(EXPIRED_REMARK);
const sourceOf = (remarks) => (/top-up/i.test(remarks || '') ? 'topup' : /admin/i.test(remarks || '') ? 'admin' : 'credit');

/**
 * Replays a client's wallet history into lots: [{ id, amount, remaining, added_at, expires_at, source }].
 * Credits open a lot; debits spend the oldest lots still valid at that moment; refunds go back to the lots
 * of the matching order (by order number), else to the most recently spent money; "Expired funds" debits
 * remove expired lots. Amounts are in cents.
 */
const replayLots = async (clientId, db = { query }) => {
    const start = await getExpiryStart();
    const minExpiry = addMonths(start, VALID_MONTHS);
    const rows = (await db.query(
        `SELECT wh.id, LOWER(wh.type) AS type, wh.price, wh.remarks, wh.created_at
         FROM wallet_histories wh
         WHERE wh.wallet_id = (SELECT id FROM wallets WHERE user_id = $1 ORDER BY id DESC LIMIT 1)
           AND COALESCE(wh.status, 1) = 1 AND LOWER(wh.type) IN ('credit', 'debit')
         ORDER BY wh.created_at, wh.id`, [clientId]
    )).rows;

    const lots = [];
    const spent = []; // [{ lot, amount, ref }] newest last – what each debit took from which lot
    const take = (amount, at, { expiredOnly = false, ref = null } = {}) => {
        let left = amount;
        const pick = (filter) => {
            for (const lot of lots.filter(filter).sort((a, b) => a.expires_at - b.expires_at || a.id - b.id)) {
                if (left <= 0) break;
                const n = Math.min(lot.remaining, left);
                if (n <= 0) continue;
                lot.remaining -= n;
                left -= n;
                if (!expiredOnly) spent.push({ lot, amount: n, ref });
            }
        };
        // Expiry debits are only written for the oldest (expired) lots, so they always come off the oldest first
        if (expiredOnly) pick(() => true);
        else {
            pick(l => l.expires_at > at);
            pick(() => true); // older data spent more than was valid – take it from anything left
        }
    };
    const giveBack = (amount, ref) => {
        let left = amount;
        for (const useRef of ref ? [true, false] : [false]) {
            for (let i = spent.length - 1; i >= 0 && left > 0; i--) {
                const s = spent[i];
                if (useRef && s.ref !== ref) continue;
                const n = Math.min(s.amount, left);
                s.lot.remaining += n;
                s.amount -= n;
                left -= n;
                if (s.amount <= 0) spent.splice(i, 1);
            }
        }
        return left;
    };

    for (const r of rows) {
        const amount = cents(r.price);
        if (amount <= 0) continue;
        const at = new Date(r.created_at);
        if (r.type === 'debit') {
            take(amount, at, { expiredOnly: isExpiry(r.remarks), ref: (String(r.remarks || '').match(ORDER_REF) || [])[0]?.toUpperCase() || null });
            continue;
        }
        let left = amount;
        if (isRefund(r.remarks)) left = giveBack(amount, (String(r.remarks || '').match(ORDER_REF) || [])[0]?.toUpperCase() || null);
        if (left > 0) {
            const natural = addMonths(at, VALID_MONTHS);
            lots.push({ id: Number(r.id), amount: left, remaining: left, added_at: at, expires_at: natural < minExpiry ? minExpiry : natural, source: sourceOf(r.remarks) });
        }
    }
    return lots;
};

const lotView = (l) => ({
    id: l.id, amount: l.amount / 100, remaining: l.remaining / 100, added_at: l.added_at, expires_at: l.expires_at, source: l.source
});

/** Money in the wallet by expiry date: { lots (still valid), due (expired, not yet removed), next_expiry } */
const walletFunds = async (clientId, db = { query }) => {
    const now = new Date();
    const lots = (await replayLots(clientId, db)).filter(l => l.remaining > 0);
    const valid = lots.filter(l => l.expires_at > now).sort((a, b) => a.expires_at - b.expires_at);
    const due = lots.filter(l => l.expires_at <= now);
    const next = valid[0] ? {
        date: valid[0].expires_at,
        amount: valid.filter(l => l.expires_at.toDateString() === valid[0].expires_at.toDateString()).reduce((s, l) => s + l.remaining, 0) / 100
    } : null;
    return { lots: valid.map(lotView), due: due.map(lotView), next_expiry: next, valid_months: VALID_MONTHS };
};

// ─── Plan + deactivation ──────────────────────────────────────────────

/** An order still being worked on (any site not live and not cancelled) */
const hasOpenOrder = async (clientId, db = { query }) => (await db.query(
    `SELECT 1 FROM (${mp.orderItemsSql} JOIN marketplace_orders mo ON mo.id = co.marketplace_order_id WHERE mo.client_user_id = $1) x
     WHERE x.status IN ('placed', 'in_progress', 'publishing') LIMIT 1`, [clientId]
)).rows.length > 0;

/**
 * Plan view for one client:
 * { tier, pro_since, pro_source, deactivated, deactivated_at, last_order_at, deactivates_on, funds, pro_price, ... }
 */
const getPlan = async (clientId, db = { query }, { withFunds = true } = {}) => {
    await ensureSchema();
    const r = (await db.query(
        `SELECT p.pro_since, p.pro_source, p.deactivated_at, p.reactivated_at,
                (SELECT MAX(created_at) FROM marketplace_orders WHERE client_user_id = $1) AS last_order_at
         FROM (SELECT $1::int AS id) c LEFT JOIN marketplace_plans p ON p.client_user_id = c.id`, [clientId]
    )).rows[0] || {};
    const pro = !!r.pro_since;
    const clockFrom = pro ? [r.last_order_at, r.pro_since, r.reactivated_at].filter(Boolean).map(d => new Date(d)).sort((a, b) => b - a)[0] : null;
    return {
        tier: pro ? 'pro' : 'free',
        pro_since: r.pro_since || null,
        pro_source: r.pro_source || null,
        deactivated: !!r.deactivated_at,
        deactivated_at: r.deactivated_at || null,
        last_order_at: r.last_order_at || null,
        // Only Pro clients can be deactivated; placing an order moves this date
        deactivates_on: pro && !r.deactivated_at ? addMonths(clockFrom, INACTIVE_MONTHS) : null,
        funds: withFunds ? await walletFunds(clientId, db) : undefined,
        pro_price: PRO_PRICE,
        valid_months: VALID_MONTHS,
        inactive_months: INACTIVE_MONTHS
    };
};
const isPro = async (clientId) => (await getPlan(clientId, undefined, { withFunds: false })).tier === 'pro';
const isDeactivated = async (clientId) => {
    await ensureSchema();
    return !!(await query(`SELECT 1 FROM marketplace_plans WHERE client_user_id = $1 AND deactivated_at IS NOT NULL`, [clientId])).rows.length;
};

const ensureRow = (tx, clientId) =>
    tx.query(`INSERT INTO marketplace_plans (client_user_id) VALUES ($1) ON CONFLICT (client_user_id) DO NOTHING`, [clientId]);

/**
 * A completed PayPal top-up: $499+ in one payment switches Pro on for life.
 * Call INSIDE the transaction that credits the wallet (tx = client). Returns { became_pro }.
 */
const applyTopup = async (tx, clientId, amount) => {
    await ensureSchema();
    const amt = Math.round(Number(amount) * 100) / 100;
    if (!(amt >= PRO_PRICE)) return { became_pro: false };
    await ensureRow(tx, clientId);
    const row = (await tx.query(
        `UPDATE marketplace_plans SET pro_since = NOW(), pro_source = 'topup', updated_at = NOW()
         WHERE client_user_id = $1 AND pro_since IS NULL RETURNING pro_since`, [clientId]
    )).rows[0];
    if (row) {
        await tx.query(`INSERT INTO marketplace_plan_events (client_user_id, kind, amount, note) VALUES ($1, 'pro', $2, 'Pro unlocked by a top-up')`, [clientId, amt]);
    }
    return { became_pro: !!row };
};

/** Admin: switch Pro on for a client (for life). Returns false when they already had Pro. */
const grantPro = async (tx, clientId, note, adminId) => {
    await ensureSchema();
    await ensureRow(tx, clientId);
    const row = (await tx.query(
        `UPDATE marketplace_plans SET pro_since = NOW(), pro_source = 'admin', updated_at = NOW()
         WHERE client_user_id = $1 AND pro_since IS NULL RETURNING pro_since`, [clientId]
    )).rows[0];
    if (row) {
        await tx.query(`INSERT INTO marketplace_plan_events (client_user_id, kind, note, created_by) VALUES ($1, 'grant', $2, $3)`, [clientId, note || 'Pro granted by admin', adminId || null]);
    }
    return !!row;
};

/** Admin: give a deactivated client full access again (the 12-month clock restarts today) */
const reactivate = async (tx, clientId, note, adminId) => {
    await ensureSchema();
    const row = (await tx.query(
        `UPDATE marketplace_plans SET deactivated_at = NULL, reactivated_at = NOW(), updated_at = NOW()
         WHERE client_user_id = $1 AND deactivated_at IS NOT NULL RETURNING client_user_id`, [clientId]
    )).rows[0];
    if (row) {
        await tx.query(`INSERT INTO marketplace_plan_events (client_user_id, kind, note, created_by) VALUES ($1, 'reactivated', $2, $3)`, [clientId, note || 'Reactivated by admin', adminId || null]);
    }
    return !!row;
};

/** Signup: remember when the client accepted the Terms */
const acceptTerms = async (tx, clientId) => {
    await ensureSchema();
    await tx.query(
        `INSERT INTO marketplace_plans (client_user_id, terms_accepted_at) VALUES ($1, NOW())
         ON CONFLICT (client_user_id) DO UPDATE SET terms_accepted_at = NOW()`, [clientId]
    );
};

/** "indiehackers.com" → "in****.com" (keeps the ending so it still looks like a domain) */
const maskDomain = (domain) => {
    const d = keyOf(domain);
    const parts = d.split('.');
    if (parts.length < 2) return '*****';
    const name = parts.shift();
    return `${name.slice(0, 2)}${'*'.repeat(Math.max(4, Math.min(8, name.length - 2)))}.${parts.join('.')}`;
};

module.exports = {
    PRO_PRICE, VALID_MONTHS, INACTIVE_MONTHS, REMIND_DAYS, EXPIRED_REMARK, FREE_SITES,
    ensureSchema, freeDomains, getPlan, isPro, isDeactivated, applyTopup, grantPro, reactivate, acceptTerms,
    replayLots, walletFunds, hasOpenOrder, setExpiryStartForTests, addMonths, maskDomain, domainKeySql, keyOf
};
