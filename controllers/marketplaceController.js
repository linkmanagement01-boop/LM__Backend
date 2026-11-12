/**
 * Marketplace (white-label first) – the client-facing storefront API
 *
 * Mounted at /api/marketplace/:marketplace  (e.g. /api/marketplace/whitelabel)
 *  - Auth: sign up (email code + temp-mail blocking, same as LinkManagement), log in
 *  - Sites: approved sites of active bloggers, marketplace prices only (no blogger details)
 *  - Cart: site + type (Guest Post / Niche Edit) + anchor + target URL
 *  - Checkout: pay from wallet (atomic), creates one marketplace order; behind it one client_order
 *    per type, so the team's existing Client Orders flow works unchanged
 *  - Orders, wallet (PayPal + Razorpay top-ups), notifications
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, transaction } = require('../config/database');
const { validateSignupEmail } = require('../utils/emailValidation');
const { sendEmail } = require('../utils/emailService');
const { activeSiteSql, findInactiveBloggerSites } = require('../utils/bloggerStatus');
const paypal = require('../utils/paypal');
const razorpay = require('../utils/razorpay');
const { COUNTRIES, cleanCountry, countryName } = require('../utils/countries');
const mp = require('../utils/marketplace');
const domainMetrics = require('../utils/domainMetrics');
const plans = require('../utils/marketplacePlan');
const { sendPlanEmail, sendPlanEmailTo } = require('../utils/marketplacePlanEmails');

const ORDER_TYPES = ['Guest Post', 'Niche Edit'];
const TOPUP_MIN = 10;      // once Pro: any top-up from $10
const TOPUP_MAX = 10000;
const SIGNUP_CREDIT = 30;  // welcome credit on sign-up – usable once the first $499 top-up unlocks Pro
const WELCOME_REMARK = 'Welcome credit';

const escapeHtml = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isHttpUrl = (v) => {
    const s = String(v || '').trim();
    if (!/^https?:\/\//i.test(s) || s.length > 255) return false;
    try { return !!new URL(s).hostname.includes('.'); } catch { return false; }
};
const marketplaceOf = (req) => req.params.marketplace;
const bad = (res, message, code = 400) => res.status(code).json({ error: 'Validation Error', message });

// ─── Middleware ───────────────────────────────────────────────────────

/** :marketplace must be a known marketplace */
const checkMarketplace = (req, res, next) => {
    if (!mp.MARKETPLACES.includes(req.params.marketplace)) {
        return res.status(404).json({ error: 'Not Found', message: 'Unknown marketplace' });
    }
    mp.ensureSchema().then(() => next()).catch(next);
};

/** Logged-in client of THIS marketplace, still active (checked live, so a blocked client loses access at once) */
const requireClient = async (req, res, next) => {
    try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'Unauthorized', message: 'Please log in' });
        let decoded;
        try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch {
            return res.status(401).json({ error: 'Unauthorized', message: 'Your session has expired – please log in again' });
        }
        const u = (await query(`SELECT id, name, email, role, status, marketplace FROM users WHERE id = $1`, [decoded.id])).rows[0];
        if (!u || u.role !== 'client' || u.marketplace !== marketplaceOf(req) || u.status !== 1) {
            return res.status(401).json({ error: 'Unauthorized', message: 'Your account is not active – please contact support' });
        }
        req.client = u;
        next();
    } catch (error) {
        next(error);
    }
};

/** Paused Pro account (no order for 12 months): only Support works until an admin reactivates it */
const requireActive = async (req, res, next) => {
    try {
        if (await plans.isDeactivated(req.client.id)) {
            return res.status(403).json({ error: 'Account Paused', code: 'account_deactivated', message: 'Your account is paused – please chat with support to reactivate it' });
        }
        next();
    } catch (error) {
        next(error);
    }
};

// ─── Auth ─────────────────────────────────────────────────────────────

/** @route POST /api/marketplace/:marketplace/auth/send-code  { name, email, country_code, password, confirm_password } */
const sendSignupCode = async (req, res, next) => {
    try {
        const marketplace = marketplaceOf(req);
        const { name, email, password, confirm_password, accept_terms } = req.body;
        if (!name || String(name).trim().length < 2) return bad(res, 'Please enter your name (at least 2 characters)');
        const country = cleanCountry(req.body.country_code);
        if (!country) return bad(res, 'Please choose your country');
        if (accept_terms !== true) return bad(res, 'Please accept the Terms & Conditions to create your account');
        if (!password || String(password).length < 8) return bad(res, 'Password must be at least 8 characters');
        if (password !== confirm_password) return bad(res, 'Passwords do not match');
        const cleanEmail = String(email || '').trim().toLowerCase();

        // Same email checks as LinkManagement signup (format, disposable / temp-mail blocking, mail server)
        const emailCheck = await validateSignupEmail(cleanEmail);
        if (!emailCheck.ok) return bad(res, emailCheck.message);

        if ((await query(`SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)`, [cleanEmail])).rows.length) {
            return res.status(409).json({ error: 'Conflict', message: 'An account with this email already exists – please log in' });
        }
        const recent = (await query(
            `SELECT EXTRACT(EPOCH FROM (NOW() - last_sent_at)) AS seconds FROM marketplace_pending_signups WHERE LOWER(email) = LOWER($1)`,
            [cleanEmail]
        )).rows[0];
        if (recent && Number(recent.seconds) < 60) {
            return res.status(429).json({ error: 'Too Many Requests', message: `Please wait ${Math.ceil(60 - Number(recent.seconds))} seconds before requesting a new code` });
        }

        const code = String(crypto.randomInt(100000, 1000000));
        const [passwordHash, codeHash] = await Promise.all([bcrypt.hash(String(password), 10), bcrypt.hash(code, 10)]);
        await query(`DELETE FROM marketplace_pending_signups WHERE LOWER(email) = LOWER($1)`, [cleanEmail]);
        await query(
            `INSERT INTO marketplace_pending_signups (marketplace, email, name, password_hash, code_hash, attempts, expires_at, last_sent_at, country_code)
             VALUES ($1,$2,$3,$4,$5,0, NOW() + INTERVAL '10 minutes', NOW(), $6)`,
            [marketplace, cleanEmail, String(name).trim(), passwordHash, codeHash, country]
        );

        const onRailway = !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
        // A developer's own PC (npm run dev, not Railway): the code is also given back so the signup page can show it –
        // local email often can't send. Never on Railway.
        const localDev = !onRailway && process.env.NODE_ENV === 'development';
        const devMode = localDev && !process.env.SMTP_PASSWORD && !process.env.EMAILIT_API_KEY;
        if (devMode) {
            console.log(`🔑 [DEV ONLY] Marketplace verification code for ${cleanEmail}: ${code}`);
            return res.json({ message: 'Verification code created (local dev)', email: cleanEmail, dev_code: code });
        } else {
            const brand = mp.getBrand(marketplace);
            const sent = await sendEmail(cleanEmail, `Verify your email – ${brand.name}`, `
                <h2>Hello ${escapeHtml(String(name).trim())},</h2>
                <p>Use this code to finish creating your ${escapeHtml(brand.name)} account:</p>
                <div class="highlight-box" style="text-align:center;">
                  <p class="label">Verification Code</p>
                  <p class="value" style="font-size:34px; letter-spacing:8px;">${code}</p>
                </div>
                <p>This code expires in <strong>10 minutes</strong>. If you didn't try to sign up, you can ignore this email.</p>`, { brand });
            if (!sent && localDev) {
                console.log(`🔑 [DEV ONLY] Email failed – marketplace verification code for ${cleanEmail}: ${code}`);
                return res.json({ message: 'Email could not be sent (local dev) – code shown on the page', email: cleanEmail, dev_code: code });
            }
            if (!sent) {
                await query(`DELETE FROM marketplace_pending_signups WHERE LOWER(email) = LOWER($1)`, [cleanEmail]);
                return res.status(500).json({ error: 'Email Failed', message: 'Could not send the verification email. Please try again later.' });
            }
        }
        res.json({ message: 'Verification code sent – please check your email', email: cleanEmail });
    } catch (error) {
        next(error);
    }
};

/** @route POST /api/marketplace/:marketplace/auth/verify  { email, code } → creates the account and logs in */
const verifySignupCode = async (req, res, next) => {
    try {
        const marketplace = marketplaceOf(req);
        const cleanEmail = String(req.body.email || '').trim().toLowerCase();
        const code = String(req.body.code || '').trim();
        if (!/^\d{6}$/.test(code)) return bad(res, 'Please enter the 6-digit code from your email');

        const pending = (await query(
            `SELECT * FROM marketplace_pending_signups WHERE LOWER(email) = LOWER($1) AND marketplace = $2`,
            [cleanEmail, marketplace]
        )).rows[0];
        if (!pending) return bad(res, 'No signup found for this email – please sign up again');
        if (new Date(pending.expires_at) < new Date()) {
            await query(`DELETE FROM marketplace_pending_signups WHERE id = $1`, [pending.id]);
            return bad(res, 'This code has expired – please sign up again');
        }
        if (pending.attempts >= 5) {
            await query(`DELETE FROM marketplace_pending_signups WHERE id = $1`, [pending.id]);
            return res.status(429).json({ error: 'Too Many Attempts', message: 'Too many wrong codes – please sign up again' });
        }
        if (!(await bcrypt.compare(code, pending.code_hash))) {
            await query(`UPDATE marketplace_pending_signups SET attempts = attempts + 1 WHERE id = $1`, [pending.id]);
            return bad(res, 'Wrong code – please check your email and try again');
        }

        const user = await transaction(async (client) => {
            const created = (await client.query(
                `INSERT INTO users (name, email, password, role, status, marketplace, email_verified_at, created_at, updated_at, country_code)
                 SELECT $1::text, $2::text, $3::text, 'client', 1, $4::text, NOW(), NOW(), NOW(), $5::text
                 WHERE NOT EXISTS (SELECT 1 FROM users WHERE LOWER(email) = LOWER($2::text))
                 RETURNING id, name, email`,
                [pending.name, cleanEmail, pending.password_hash, marketplace, pending.country_code || null]
            )).rows[0];
            if (!created) return null;
            const wallet = (await client.query(
                `INSERT INTO wallets (user_id, balance, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id`, [created.id, SIGNUP_CREDIT]
            )).rows[0];
            await client.query(
                `INSERT INTO wallet_histories (wallet_id, type, price, remarks, status, created_at, updated_at, approved_date)
                 VALUES ($1,'Credit',$2,$3,1,NOW(),NOW(),NOW())`,
                [wallet.id, SIGNUP_CREDIT, `${WELCOME_REMARK} – $${SIGNUP_CREDIT} for signing up`]
            );
            await plans.acceptTerms(client, created.id); // a code is only sent after the Terms were accepted
            await client.query(`DELETE FROM marketplace_pending_signups WHERE id = $1`, [pending.id]);
            return created;
        });
        if (!user) return res.status(409).json({ error: 'Conflict', message: 'An account with this email already exists – please log in' });

        const token = jwt.sign({ id: user.id, email: user.email, role: 'Client', marketplace }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '24h' });
        res.status(201).json({ message: `Account created – $${SIGNUP_CREDIT} welcome credit added to your wallet`, token, user: { id: user.id, name: user.name, email: user.email, wallet_balance: SIGNUP_CREDIT } });
    } catch (error) {
        next(error);
    }
};

/** @route POST /api/marketplace/:marketplace/auth/login  { email, password } */
const login = async (req, res, next) => {
    try {
        const marketplace = marketplaceOf(req);
        const cleanEmail = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '');
        const u = (await query(
            `SELECT u.id, u.name, u.email, u.password, u.role, u.status, u.marketplace, COALESCE(w.balance, 0) AS balance
             FROM users u LEFT JOIN wallets w ON w.user_id = u.id
             WHERE LOWER(u.email) = LOWER($1) ORDER BY w.id DESC NULLS LAST LIMIT 1`,
            [cleanEmail]
        )).rows[0];
        // Same message for every failure, so emails can't be probed
        if (!u || u.role !== 'client' || u.marketplace !== marketplace || !(await bcrypt.compare(password, u.password || ''))) {
            return res.status(401).json({ error: 'Unauthorized', message: 'Wrong email or password' });
        }
        if (u.status !== 1) return res.status(403).json({ error: 'Account Disabled', message: 'Your account is not active – please contact support' });
        await query(`UPDATE users SET last_login = NOW(), login_count = COALESCE(login_count, 0) + 1 WHERE id = $1`, [u.id]);
        const token = jwt.sign({ id: u.id, email: u.email, role: 'Client', marketplace }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '24h' });
        res.json({ token, user: { id: u.id, name: u.name, email: u.email, wallet_balance: Number(u.balance) } });
    } catch (error) {
        next(error);
    }
};

/** @route GET /api/marketplace/:marketplace/me */
const me = async (req, res, next) => {
    try {
        const w = (await query(`SELECT COALESCE(balance, 0) AS balance FROM wallets WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [req.client.id])).rows[0];
        const cart = (await query(`SELECT COUNT(*) AS c FROM marketplace_cart_items WHERE client_user_id = $1`, [req.client.id])).rows[0];
        const plan = await plans.getPlan(req.client.id);
        const country = (await query(`SELECT country_code FROM users WHERE id = $1`, [req.client.id])).rows[0]?.country_code || null;
        res.json({ user: { id: req.client.id, name: req.client.name, email: req.client.email, country_code: country }, wallet_balance: Number(w?.balance || 0), cart_count: parseInt(cart.c), plan });
    } catch (error) {
        next(error);
    }
};

// ─── Sites ────────────────────────────────────────────────────────────

// The category a client sees (category, else niche) and its case-insensitive key
const categorySql = `COALESCE(NULLIF(TRIM(ns.category), ''), NULLIF(TRIM(ns.niche), ''))`;
const categoryKeySql = `LOWER(${categorySql})`;

const siteListWhere =`(ns.delete_site IS NULL OR ns.delete_site = 0) AND ns.site_status = '1' AND ${activeSiteSql('ns')}`;
const trafficSql = `(CASE WHEN ns.traffic_source::text ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.traffic_source::numeric ELSE 0 END)`;

/**
 * @route GET /api/marketplace/:marketplace/sites
 * Query: search, category, min/max_da, min/max_dr, min/max_traffic, min/max_price, type (gp|ne), sort, page, limit
 */
/**
 * @route GET /api/marketplace/:marketplace/sites/categories?fc=1
 * Categories of the sites a client can order (normal or FC prices), with counts.
 * Spellings that differ only in capitals are merged; the most common spelling is shown.
 */
const getCategories = async (req, res, next) => {
    try {
        const fc = req.query.fc === '1' || req.query.fc === 'true';
        const rules = await mp.getRules(marketplaceOf(req), fc ? 'fc' : 'normal');
        const cols = mp.priceColumns(fc);
        const gpPrice = mp.priceSql(`ns.${cols.gp}`, rules);
        const nePrice = mp.priceSql(`ns.${cols.ne}`, rules);
        const rows = (await query(
            `SELECT (ARRAY_AGG(name ORDER BY c DESC, name))[1] AS name, SUM(c)::int AS count
             FROM (SELECT ${categorySql} AS name, ${categoryKeySql} AS key, COUNT(*) AS c
                   FROM new_sites ns
                   WHERE ${siteListWhere} AND (${gpPrice} IS NOT NULL OR ${nePrice} IS NOT NULL) AND ${categorySql} IS NOT NULL
                   GROUP BY 1, 2) t
             GROUP BY key
             ORDER BY count DESC, name`
        )).rows;
        res.json({ categories: rows });
    } catch (error) {
        next(error);
    }
};

const getSites = async (req, res, next) => {
    try {
        const q = req.query;
        // FC = sites' FC prices (fc_gp / fc_ne) with the FC price rules; otherwise the normal prices
        const fc = q.fc === '1' || q.fc === 'true';
        const rules = await mp.getRules(marketplaceOf(req), fc ? 'fc' : 'normal');
        const cols = mp.priceColumns(fc);
        const gpPrice = mp.priceSql(`ns.${cols.gp}`, rules);
        const nePrice = mp.priceSql(`ns.${cols.ne}`, rules);
        const page = Math.max(1, parseInt(q.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(q.limit) || 25));
        const where = [siteListWhere, `(${gpPrice} IS NOT NULL OR ${nePrice} IS NOT NULL)`];
        const params = [];
        // cond builds the SQL from the placeholder (never search/replace inside SQL – price expressions contain '?')
        const add = (cond, value) => { params.push(value); where.push(cond(`$${params.length}`)); };

        // Free plan: the free sites by default; with filters other sites show MASKED (name + sample never leave the server); page 1 only
        const pro = await plans.isPro(req.client.id);
        if (!pro && page > 1) {
            return res.status(403).json({ error: 'Pro Required', code: 'pro_required', message: 'Unlock Pro to see more pages of sites' });
        }
        const freeList = pro ? [] : await plans.freeDomains(marketplaceOf(req));
        params.push(freeList);
        const isFreeSql = `(${plans.domainKeySql('ns')} = ANY($${params.length}::text[]))`;
        const filtered = ['category', 'min_price', 'max_price', 'min_dr', 'max_dr', 'min_da', 'max_da', 'min_traffic', 'max_traffic']
            .some(k => q[k] !== undefined && q[k] !== '');
        if (!pro && (!filtered || q.search)) where.push(isFreeSql); // default view + domain search: free sites only

        if (q.search) add(p => `ns.root_domain ILIKE ${p}`, `%${String(q.search).trim()}%`);
        // Category picked from the list (spellings that differ only in capitals count as one)
        if (q.category) add(p => `${categoryKeySql} = LOWER(TRIM(${p}))`, String(q.category));
        const range = (col, min, max) => {
            if (min !== undefined && min !== '' && !isNaN(Number(min))) add(p => `${col} >= ${p}`, Number(min));
            if (max !== undefined && max !== '' && !isNaN(Number(max))) add(p => `${col} <= ${p}`, Number(max));
        };
        range('ns.da', q.min_da, q.max_da);
        range('ns.dr', q.min_dr, q.max_dr);
        range(trafficSql, q.min_traffic, q.max_traffic);
        const priceCol = q.type === 'ne' ? nePrice : q.type === 'gp' ? gpPrice : `LEAST(COALESCE(${gpPrice}, 1e12), COALESCE(${nePrice}, 1e12))`;
        if (q.type === 'gp') where.push(`${gpPrice} IS NOT NULL`);
        if (q.type === 'ne') where.push(`${nePrice} IS NOT NULL`);
        range(priceCol, q.min_price, q.max_price);

        const sorts = {
            newest: 'ns.created_at DESC NULLS LAST',
            price_asc: `${priceCol} ASC`,
            price_desc: `${priceCol} DESC`,
            dr_desc: 'ns.dr DESC NULLS LAST',
            da_desc: 'ns.da DESC NULLS LAST',
            traffic_desc: `${trafficSql} DESC`
        };
        const orderBy = sorts[q.sort] || sorts.newest;
        const whereSql = where.join(' AND ');

        const counted = (await query(`SELECT COUNT(*) AS c, COUNT(*) FILTER (WHERE ${isFreeSql}) AS free_c FROM new_sites ns WHERE ${whereSql}`, params)).rows[0];
        const total = parseInt(counted.c);
        const rows = (await query(
            `SELECT ns.id, ns.root_domain, COALESCE(NULLIF(ns.category, ''), ns.niche) AS category, ns.website_niche,
                    ns.da, ns.dr, ns.rd, ${trafficSql} AS traffic, ns.spam_score, ns.country_source AS country,
                    ns.sample_url, ns.created_at, ${isFreeSql} AS is_free,
                    ${gpPrice} AS gp_price, ${nePrice} AS niche_edit_price,
                    -- latest Ahrefs check (same as the admin cards); only client-safe fields
                    st.organic_traffic::float8 AS ahrefs_traffic, st.checked_at AS ahrefs_checked_at,
                    st.history AS ahrefs_history, st.top_countries AS ahrefs_countries, st.growth_pct::float8 AS growth_pct
             FROM new_sites ns
             LEFT JOIN site_traffic st ON st.site_id = ns.id
             WHERE ${whereSql}
             ORDER BY ${pro ? '' : 'is_free DESC, '}${orderBy}, ns.id DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, (page - 1) * limit]
        )).rows.map(r => {
            const locked = !pro && !r.is_free;
            return {
                ...r,
                root_domain: locked ? plans.maskDomain(r.root_domain) : r.root_domain,
                sample_url: locked ? null : r.sample_url,
                locked,
                traffic: Number(r.traffic) || 0,
                gp_price: r.gp_price === null ? null : Number(r.gp_price),
                niche_edit_price: r.niche_edit_price === null ? null : Number(r.niche_edit_price)
            };
        });
        // Whole-marketplace numbers (ignoring the client's filters) for the banner – always the normal prices
        const nRules = fc ? await mp.getRules(marketplaceOf(req), 'normal') : rules;
        const nGp = fc ? mp.priceSql('ns.gp_price', nRules) : gpPrice;
        const nNe = fc ? mp.priceSql('ns.niche_edit_price', nRules) : nePrice;
        const stats = (await query(
            `SELECT COUNT(*) AS sites, MAX(CASE WHEN ns.dr <= 100 THEN ns.dr END) AS top_dr, -- ignore impossible DR values
                    ROUND(AVG(CASE WHEN ns.dr > 0 AND ns.dr <= 100 THEN ns.dr END)) AS avg_dr,
                    MIN(LEAST(COALESCE(${nGp}, 1e12), COALESCE(${nNe}, 1e12))) AS min_price,
                    MAX(GREATEST(COALESCE(${nGp}, 0), COALESCE(${nNe}, 0))) AS max_price
             FROM new_sites ns WHERE ${siteListWhere} AND (${nGp} IS NOT NULL OR ${nNe} IS NOT NULL)`
        )).rows[0];
        // Price range of what's listed now (FC prices when FC is on) for the price filter hint
        const range2 = fc ? (await query(
            `SELECT COUNT(*) AS sites, MIN(LEAST(COALESCE(${gpPrice}, 1e12), COALESCE(${nePrice}, 1e12))) AS min_price,
                    MAX(GREATEST(COALESCE(${gpPrice}, 0), COALESCE(${nePrice}, 0))) AS max_price
             FROM new_sites ns WHERE ${siteListWhere} AND (${gpPrice} IS NOT NULL OR ${nePrice} IS NOT NULL)`
        )).rows[0] : stats;
        res.json({
            plan: { tier: pro ? 'pro' : 'free' },
            free_matches: pro ? null : parseInt(counted.free_c),
            free_sites: pro ? null : freeList.length, // how many free sites a Free-plan search looks through
            sites: rows,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            fc,
            stats: { sites: parseInt(stats.sites), top_dr: Number(stats.top_dr) || 0, avg_dr: Number(stats.avg_dr) || 0, min_price: Number(stats.min_price) || 0, max_price: Number(stats.max_price) || 0 },
            price_range: { sites: parseInt(range2.sites), min_price: Number(range2.min_price) || 0, max_price: Number(range2.max_price) || 0 }
        });
    } catch (error) {
        next(error);
    }
};

/** Free plan: only the free sites can be ordered (returns the plan, or null when the site is allowed) */
const PRO_REQUIRED = { error: 'Pro Required', code: 'pro_required', message: 'This site is part of Pro – unlock Pro to order it' };
const lockedSiteIds = async (req, siteIds) => {
    if (!siteIds.length || await plans.isPro(req.client.id)) return [];
    const free = await plans.freeDomains(marketplaceOf(req));
    const rows = (await query(
        `SELECT ns.id FROM new_sites ns WHERE ns.id = ANY($1::int[]) AND NOT (${plans.domainKeySql('ns')} = ANY($2::text[]))`,
        [siteIds.map(Number), free]
    )).rows;
    return rows.map(x => Number(x.id));
};

/** Current marketplace price of one site for a type (null = not for sale / not available) */
const priceFor = async (siteId, orderType, rules, fc = false) => {
    const s = (await query(
        `SELECT ns.id, ns.root_domain, ns.gp_price, ns.niche_edit_price, ns.fc_gp, ns.fc_ne FROM new_sites ns WHERE ns.id = $1 AND ${siteListWhere}`,
        [siteId]
    )).rows[0];
    if (!s) return { site: null, price: null };
    const cols = mp.priceColumns(fc);
    return { site: s, price: mp.applyRules(orderType === 'Guest Post' ? s[cols.gp] : s[cols.ne], rules) };
};

// ─── Cart ─────────────────────────────────────────────────────────────

const cartContents = async (clientId, marketplace) => {
    const rulesByKind = { normal: await mp.getRules(marketplace, 'normal'), fc: await mp.getRules(marketplace, 'fc') };
    const items = (await query(
        `SELECT c.id, c.site_id, c.order_type, c.anchor_text, c.target_url, c.created_at,
                c.content_by, c.doc_url, c.doc_name, c.reference_url, c.title_suggestion, c.word_count, c.category AS brief_category,
                c.keywords, c.target_country, c.note, c.post_url, c.post_title, c.project_id, pr.domain AS project_domain,
                c.fc, ns.root_domain, ns.gp_price AS b_gp, ns.niche_edit_price AS b_ne, ns.fc_gp AS b_fc_gp, ns.fc_ne AS b_fc_ne, ns.da, ns.dr, ns.rd,
                COALESCE(NULLIF(ns.category, ''), ns.niche) AS category,
                (ns.id IS NOT NULL AND ${siteListWhere.replace(/ns\./g, 'ns.')}) AS available
         FROM marketplace_cart_items c
         LEFT JOIN new_sites ns ON ns.id = c.site_id
         LEFT JOIN marketplace_projects pr ON pr.id = c.project_id AND pr.client_user_id = c.client_user_id
         WHERE c.client_user_id = $1
         ORDER BY c.created_at ASC`,
        [clientId]
    )).rows.map(r => {
        const isGP = r.order_type === 'Guest Post';
        const blogger = r.fc ? (isGP ? r.b_fc_gp : r.b_fc_ne) : (isGP ? r.b_gp : r.b_ne);
        const base = r.available ? mp.applyRules(blogger, rulesByKind[r.fc ? 'fc' : 'normal']) : null;
        const fee = writingFee(r);
        const { b_gp, b_ne, b_fc_gp, b_fc_ne, ...rest } = r;
        return { ...rest, base_price: base, writing_fee: fee, price: base === null ? null : base + fee, available: !!r.available && base !== null };
    });
    const total = items.filter(i => i.available).reduce((s, i) => s + i.price, 0);
    return { items, total: Math.round(total * 100) / 100 };
};

/** @route GET /api/marketplace/:marketplace/cart */
const getCart = async (req, res, next) => {
    try {
        res.json(await cartContents(req.client.id, marketplaceOf(req)));
    } catch (error) {
        next(error);
    }
};

// "Write the content for me" is an extra on top of the Guest Post price (USD, by word count)
const WRITING_FEES = { 500: 5, 750: 10, 1000: 15 };
const WORD_COUNTS = Object.keys(WRITING_FEES).map(Number);
const writingFee = (item) => (item.order_type === 'Guest Post' && item.content_by === 'us' ? (WRITING_FEES[item.word_count] || 0) : 0);
const DETAIL_FIELDS = ['content_by', 'doc_url', 'doc_name', 'reference_url', 'title_suggestion', 'word_count', 'category',
    'keywords', 'target_country', 'note', 'post_url', 'post_title'];
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const sameSite = (url, domain) => {
    const h = hostOf(url);
    const d = String(domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    return !!h && !!d && (h === d || h.endsWith(`.${d}`));
};

/**
 * Checks one cart line and returns { error } or { fields } with every detail column set (unused ones null).
 * Guest Post: content_by 'client' (file / Doc link) or 'us' (writing brief). Niche Edit: an existing post on the same site.
 */
const cleanCartInput = (body, orderType, site) => {
    const txt = (k, max) => { const v = String(body[k] ?? '').trim(); return v ? v.slice(0, max) : null; };
    if (!ORDER_TYPES.includes(orderType)) return { error: 'Please choose Guest Post or Niche Edit' };
    const anchor = String(body.anchor_text || '').trim();
    if (!anchor) return { error: 'Please enter the anchor text' };
    if (anchor.length > 200) return { error: 'Anchor text is too long (max 200 characters)' };
    if (!isHttpUrl(body.target_url)) return { error: 'Please enter a full target URL starting with http:// or https://' };
    const reference = txt('reference_url', 1000);
    if (reference && !isHttpUrl(reference)) return { error: 'Reference link must start with http:// or https://' };

    const f = Object.fromEntries(DETAIL_FIELDS.map(k => [k, null]));
    f.anchor_text = anchor;
    f.target_url = String(body.target_url).trim();
    f.note = txt('note', 1000);

    if (orderType === 'Guest Post') {
        f.content_by = body.content_by;
        f.reference_url = reference;
        if (f.content_by === 'client') {
            const ownUpload = /^https?:\/\/[^/\s]+\/uploads\/content-files\/mp-[\w-]+\.(pdf|docx?)$/i.test(String(body.doc_url || '').trim());
            if (!ownUpload && !isHttpUrl(body.doc_url)) return { error: 'Please upload your content file or paste a Google Doc link' };
            f.doc_url = String(body.doc_url).trim().slice(0, 1000);
            f.doc_name = txt('doc_name', 200);
        } else if (f.content_by === 'us') {
            f.word_count = parseInt(body.word_count);
            if (!WORD_COUNTS.includes(f.word_count)) return { error: 'Please choose a word count' };
            f.category = txt('category', 100);
            if (!f.category) return { error: 'Please choose a category' };
            f.keywords = txt('keywords', 300);
            if (!f.keywords) return { error: 'Please enter at least one keyword' };
            f.target_country = txt('target_country', 60);
            if (!f.target_country) return { error: 'Please choose the target audience country' };
            f.title_suggestion = txt('title_suggestion', 200);
        } else {
            return { error: 'Please choose who provides the content' };
        }
    } else {
        if (!isHttpUrl(body.post_url)) return { error: 'Please choose the post where your link should go' };
        if (!sameSite(body.post_url, site.root_domain)) return { error: `The post must be on ${site.root_domain}` };
        f.post_url = String(body.post_url).trim().slice(0, 1000);
        f.post_title = txt('post_title', 300);
    }
    return { fields: f };
};

const CART_COLUMNS = ['anchor_text', 'target_url', 'project_id', ...DETAIL_FIELDS];

/** The client's own project (every cart line must belong to one) */
const projectOf = async (req, projectId) => {
    const id = parseInt(projectId, 10);
    if (!id) return null;
    return (await query(`SELECT id, domain FROM marketplace_projects WHERE id = $1 AND client_user_id = $2 AND marketplace = $3`,
        [id, req.client.id, marketplaceOf(req)])).rows[0] || null;
};

/** @route POST /api/marketplace/:marketplace/cart  { site_id, order_type, anchor_text, target_url, ...content details } */
const addToCart = async (req, res, next) => {
    try {
        // Ordering (and the cart) opens with the first $499+ top-up
        if (!(await plans.isPro(req.client.id))) {
            return res.status(403).json({ ...PRO_REQUIRED, message: `Add $${plans.PRO_PRICE} to your wallet to unlock Pro and start ordering` });
        }
        const fc = req.body.fc === true;
        const rules = await mp.getRules(marketplaceOf(req), fc ? 'fc' : 'normal');
        const { site, price } = await priceFor(parseInt(req.body.site_id), req.body.order_type, rules, fc);
        if (!site) return bad(res, 'This site is not available any more', 404);
        if (price === null) return bad(res, `${site.root_domain} doesn't offer ${fc ? 'FC ' : ''}${req.body.order_type}`);
        if ((await lockedSiteIds(req, [site.id])).length) return res.status(403).json(PRO_REQUIRED);
        const project = await projectOf(req, req.body.project_id);
        if (!project) return bad(res, 'Please choose a project (or create one) for this order');
        const { error, fields } = cleanCartInput(req.body, req.body.order_type, site);
        if (error) return bad(res, error);
        fields.project_id = project.id;

        const values = CART_COLUMNS.map(c => fields[c]);
        await query(
            `INSERT INTO marketplace_cart_items (client_user_id, site_id, order_type, fc, ${CART_COLUMNS.join(', ')})
             VALUES ($1,$2,$3,$4,${CART_COLUMNS.map((_, i) => `$${i + 5}`).join(',')})
             ON CONFLICT (client_user_id, site_id, order_type, fc)
             DO UPDATE SET ${CART_COLUMNS.map(c => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = NOW()`,
            [req.client.id, site.id, req.body.order_type, fc, ...values]
        );
        res.status(201).json({ message: `${site.root_domain} (${fc ? 'FC ' : ''}${req.body.order_type}) added to cart`, ...(await cartContents(req.client.id, marketplaceOf(req))) });
    } catch (error) {
        next(error);
    }
};

/** @route PUT /api/marketplace/:marketplace/cart/:id  { anchor_text, target_url, ...content details } */
const updateCartItem = async (req, res, next) => {
    try {
        const item = (await query(
            `SELECT c.*, ns.root_domain FROM marketplace_cart_items c LEFT JOIN new_sites ns ON ns.id = c.site_id
             WHERE c.id = $1 AND c.client_user_id = $2`, [req.params.id, req.client.id]
        )).rows[0];
        if (!item) return bad(res, 'Cart item not found', 404);
        if ((await lockedSiteIds(req, [item.site_id])).length) return res.status(403).json(PRO_REQUIRED);
        const project = await projectOf(req, req.body.project_id ?? item.project_id);
        if (!project) return bad(res, 'Please choose a project (or create one) for this order');
        const { error, fields } = cleanCartInput(req.body, item.order_type, item);
        if (error) return bad(res, error);
        fields.project_id = project.id;
        await query(
            `UPDATE marketplace_cart_items SET ${CART_COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW()
             WHERE id = $${CART_COLUMNS.length + 1}`,
            [...CART_COLUMNS.map(c => fields[c]), item.id]
        );
        res.json(await cartContents(req.client.id, marketplaceOf(req)));
    } catch (error) {
        next(error);
    }
};

// ─── Content upload + Niche Edit post search ──────────────────────────

/** @route POST /api/marketplace/:marketplace/uploads/content  (multipart "file": pdf/doc/docx) → { url, name } */
const uploadContent = (req, res) => {
    if (!req.file) return bad(res, 'Please choose a PDF, DOC or DOCX file');
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
    const base = (process.env.PUBLIC_API_URL || `${proto}://${req.get('host')}`).replace(/\/+$/, '').replace(/\/api$/, '');
    res.status(201).json({ url: `${base}/uploads/content-files/${req.file.filename}`, name: req.file.originalname.slice(0, 200) });
};

const postWords = (q) => [...new Set(String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2))].slice(0, 6);
const indexingNow = new Map(); // site id → running index promise (one at a time per site)

/** Reads the site's sitemap now if we have no posts for it (at most every 12h), waiting up to ~20s */
const ensurePostsIndexed = async (site) => {
    const postIndexer = require('../jobs/postIndexer');
    await postIndexer.ensureSchema();
    const src = (await query(
        `SELECT status, post_count, last_indexed_at, (last_indexed_at < NOW() - INTERVAL '12 hours') AS stale FROM site_post_sources WHERE site_id = $1`, [site.id]
    )).rows[0];
    if (src && (Number(src.post_count) > 0 || !src.stale)) return { status: src.status, indexing: false };
    if (!indexingNow.has(site.id)) {
        const p = postIndexer.indexSite({ id: site.id, root_domain: site.root_domain })
            .catch(err => console.error('[Marketplace] live post index failed', site.root_domain, err.message))
            .finally(() => indexingNow.delete(site.id));
        indexingNow.set(site.id, p);
    }
    const finished = await Promise.race([indexingNow.get(site.id).then(() => true), new Promise(r => setTimeout(() => r(false), 20000))]);
    const after = (await query(`SELECT status FROM site_post_sources WHERE site_id = $1`, [site.id])).rows[0];
    return { status: after?.status || 'pending', indexing: !finished };
};

/** @route GET /api/marketplace/:marketplace/sites/:id/posts?q&page – posts on ONE site, for choosing a Niche Edit post */
const getSitePosts = async (req, res, next) => {
    try {
        const site = (await query(`SELECT ns.id, ns.root_domain FROM new_sites ns WHERE ns.id = $1 AND ${siteListWhere}`, [req.params.id])).rows[0];
        if (!site) return bad(res, 'This site is not available any more', 404);
        if ((await lockedSiteIds(req, [site.id])).length) return res.status(403).json(PRO_REQUIRED);
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 20;
        const { status, indexing } = await ensurePostsIndexed(site);

        const words = postWords(req.query.q);
        const params = [site.id];
        let where = 'sp.site_id = $1';
        let score = '0';
        if (words.length) {
            // Every post containing at least one word; posts matching more words come first
            const conds = words.map(w => { params.push(`% ${w}%`); return `(' ' || sp.search_text) LIKE $${params.length}`; });
            where += ` AND (${conds.join(' OR ')})`;
            score = conds.map(c => `(CASE WHEN ${c} THEN 1 ELSE 0 END)`).join(' + ');
        }
        const total = parseInt((await query(`SELECT COUNT(*) AS c FROM site_posts sp WHERE ${where}`, params)).rows[0].c);
        const posts = (await query(
            `SELECT sp.id, sp.url, sp.title, sp.lastmod, ${score} AS match_count FROM site_posts sp WHERE ${where}
             ORDER BY match_count DESC, sp.lastmod DESC NULLS LAST, sp.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
            params
        )).rows;
        res.json({ domain: site.root_domain, status, indexing, words, posts, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    } catch (error) {
        next(error);
    }
};

/** @route DELETE /api/marketplace/:marketplace/cart/:id */
const removeCartItem = async (req, res, next) => {
    try {
        await query(`DELETE FROM marketplace_cart_items WHERE id = $1 AND client_user_id = $2`, [req.params.id, req.client.id]);
        res.json(await cartContents(req.client.id, marketplaceOf(req)));
    } catch (error) {
        next(error);
    }
};

// ─── Checkout ─────────────────────────────────────────────────────────

/** Next manager in the round-robin used by the existing client orders */
const nextManager = async (client) => {
    const managers = (await client.query(`SELECT id FROM users WHERE role = 'manager' AND status = 1 ORDER BY id ASC`)).rows.map(r => parseInt(r.id, 10));
    if (!managers.length) return null;
    const last = (await client.query(`SELECT assigned_to FROM client_orders WHERE assigned_to IS NOT NULL ORDER BY created_at DESC LIMIT 1`)).rows[0];
    const idx = last ? managers.indexOf(parseInt(last.assigned_to, 10)) : -1;
    return managers[(idx + 1) % managers.length];
};

/**
 * @route POST /api/marketplace/:marketplace/checkout
 * Pays the whole cart from the wallet and places ONE order for the client.
 * Prices are recalculated here (never taken from the browser). All-or-nothing.
 */
const checkout = async (req, res, next) => {
    try {
        const marketplace = marketplaceOf(req);
        const clientId = req.client.id;
        const { items, total } = await cartContents(clientId, marketplace);
        if (items.length === 0) return bad(res, 'Your cart is empty');
        // Ordering opens with the first $499+ top-up (Pro) – say so before any other cart check
        if (!(await plans.isPro(clientId))) {
            return res.status(403).json({ ...PRO_REQUIRED, message: `Add $${plans.PRO_PRICE} to your wallet to unlock Pro and place your order` });
        }
        const unavailable = items.filter(i => !i.available);
        if (unavailable.length) {
            return bad(res, `Please remove sites that are no longer available: ${unavailable.map(i => i.root_domain || `#${i.site_id}`).join(', ')}`);
        }
        const inactive = await findInactiveBloggerSites(items.map(i => i.site_id));
        if (inactive.length) return bad(res, `Please remove sites that are no longer available: ${inactive.join(', ')}`);
        const locked = await lockedSiteIds(req, items.map(i => i.site_id));
        if (locked.length) {
            const names = items.filter(i => locked.includes(Number(i.site_id))).map(i => i.root_domain).join(', ');
            return res.status(403).json({ ...PRO_REQUIRED, message: `Your cart has Pro sites (${names}) – unlock Pro or remove them to place the order` });
        }
        for (const i of items) {
            const { error } = cleanCartInput({ ...i, category: i.brief_category }, i.order_type, i);
            if (error) return bad(res, `${i.root_domain} (${i.order_type}): ${error} – please edit it in your cart`);
            if (!i.project_domain) return bad(res, `${i.root_domain} (${i.order_type}): choose a project – please edit it in your cart`);
        }

        const result = await transaction(async (client) => {
            // Lock the wallet row, so two checkouts can't spend the same money
            const wallet = (await client.query(
                `SELECT id, balance FROM wallets WHERE user_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE`, [clientId]
            )).rows[0];
            if (!wallet || Number(wallet.balance) + 1e-9 < total) {
                const e = new Error(`Not enough balance: your order is $${total.toFixed(2)}, your wallet has $${Number(wallet?.balance || 0).toFixed(2)}. Please add funds.`);
                e.statusCode = 400;
                throw e;
            }
            await client.query(`UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE id = $2`, [total, wallet.id]);

            const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const orderNumber = `MP-${day}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
            const mOrder = (await client.query(
                `INSERT INTO marketplace_orders (marketplace, client_user_id, order_number, total_price) VALUES ($1,$2,$3,$4) RETURNING id`,
                [marketplace, clientId, orderNumber, total]
            )).rows[0];

            // One client_order per type (and normal / FC) for the team – their flow handles one type + one price list per order
            const managerId = await nextManager(client);
            for (const [type, fc] of ORDER_TYPES.flatMap(t => [[t, false], [t, true]])) {
                const group = items.filter(i => i.order_type === type && !!i.fc === fc);
                if (!group.length) continue;
                const groupTotal = Math.round(group.reduce((s, i) => s + i.price, 0) * 100) / 100;
                // fill_details = false only for "write the content for us" – those go to a writer
                const rows = group.map(i => ({ ...i, fill: !(type === 'Guest Post' && i.content_by === 'us') }));
                const co = (await client.query(
                    `INSERT INTO client_orders (client_user_id, order_type, no_of_links, status, fill_details, notes, order_package, category,
                                                total_price, assigned_to, assigned_at, created_at, order_number, marketplace, marketplace_order_id, fc)
                     VALUES ($1,$2,$3,'pending_review',$11,$4,'','',$5,$6,$7,NOW(),$8,$9,$10,$12) RETURNING id`,
                    [clientId, type, group.length, `Marketplace order ${orderNumber}`, groupTotal, managerId, managerId ? new Date() : null,
                        `${orderNumber}-${type === 'Guest Post' ? 'GP' : 'NE'}${fc ? '-FC' : ''}`, marketplace, mOrder.id, rows.every(r => r.fill), fc ? 1 : 0]
                )).rows[0];
                for (const i of rows) {
                    const brief = type === 'Guest Post' && i.content_by === 'us'
                        ? { language: 'English', word_count: i.word_count, writing_fee: i.writing_fee, category: i.brief_category, keywords: i.keywords, target_country: i.target_country, title_suggestion: i.title_suggestion, reference_url: i.reference_url }
                        : i.reference_url ? { reference_url: i.reference_url } : null;
                    await client.query(
                        `INSERT INTO client_order_details (client_order_id, site_id, target_url, anchor_text, article_title, doc_url, post_url, note,
                                                           fill_details, content_by, brief, price, project_id, created_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())`,
                        [co.id, i.site_id, i.target_url, i.anchor_text, i.title_suggestion || '', i.doc_url || '', i.post_url || '',
                            i.note || '', i.fill, type === 'Guest Post' ? i.content_by : null, brief ? JSON.stringify(brief) : null, i.price, i.project_id]
                    );
                }
            }
            await client.query(
                `INSERT INTO wallet_histories (wallet_id, type, price, remarks, status, created_at, updated_at, approved_date)
                 VALUES ($1,'Debit',$2,$3,1,NOW(),NOW(),NOW())`,
                [wallet.id, total, `Order ${orderNumber} (${items.length} site${items.length > 1 ? 's' : ''})`]
            );
            await client.query(`DELETE FROM marketplace_cart_items WHERE client_user_id = $1`, [clientId]);
            return { orderNumber, orderId: mOrder.id, balance: Number(wallet.balance) - total };
        });

        // Confirmation email (after the money moved; a failed email never undoes the order)
        const brand = mp.getBrand(marketplace);
        sendEmail(req.client.email, `Order ${result.orderNumber} received – ${brand.name}`, `
            <h2>Thank you, ${escapeHtml(req.client.name || '')}!</h2>
            <p>We received your order <strong>${result.orderNumber}</strong> for <strong>${items.length}</strong> site${items.length > 1 ? 's' : ''}
               (total <strong>$${total.toFixed(2)}</strong>). Our team has started working on it – we'll email you as each link goes live.</p>
            <div class="table-wrap"><table><thead><tr><th>Website</th><th>Type</th><th>Anchor</th><th>Price</th></tr></thead><tbody>
            ${items.map(i => `<tr><td>${escapeHtml(i.root_domain)}</td><td>${i.order_type}</td><td>${escapeHtml(i.anchor_text)}</td><td>$${i.price.toFixed(2)}</td></tr>`).join('')}
            </tbody></table></div>
            <a href="${brand.url}/orders" class="btn">View my order →</a>`, { brand }).catch(() => {});

        res.status(201).json({ message: 'Order placed', order_id: result.orderId, order_number: result.orderNumber, total, wallet_balance: Math.round(result.balance * 100) / 100 });
    } catch (error) {
        if (error.statusCode === 400) return bad(res, error.message);
        next(error);
    }
};

// ─── Orders ───────────────────────────────────────────────────────────

/** Per-site status the client sees (shared SQL lives in utils/marketplace.js) */
const { SITE_STATUS_SQL, orderItemsSql } = mp;

const summarize = (items) => {
    const counts = { placed: 0, in_progress: 0, publishing: 0, live: 0, cancelled: 0 };
    for (const i of items) counts[i.status] = (counts[i.status] || 0) + 1;
    const active = items.length - counts.cancelled;
    const status = active === 0 ? 'cancelled'
        : counts.live === active ? 'completed'
            : counts.live > 0 || counts.publishing > 0 || counts.in_progress > 0 ? 'in_progress' : 'placed';
    return { status, counts };
};

/**
 * @route GET /api/marketplace/:marketplace/orders?page&limit&status=placed|in_progress|completed|cancelled&search
 * Status is worked out from the order's sites, so orders are summarised first, then filtered + paginated.
 */
const getOrders = async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const status = String(req.query.status || '');
        const search = String(req.query.search || '').trim().toLowerCase();

        const orders = (await query(
            `SELECT id, order_number, total_price::float AS total_price, created_at FROM marketplace_orders
             WHERE client_user_id = $1 AND marketplace = $2 ORDER BY created_at DESC`,
            [req.client.id, marketplaceOf(req)]
        )).rows;
        const items = orders.length ? (await query(`${orderItemsSql} WHERE co.marketplace_order_id = ANY($1::int[]) ORDER BY cod.id`, [orders.map(o => o.id)])).rows : [];
        const byOrder = new Map(orders.map(o => [o.id, []]));
        for (const i of items) byOrder.get(i.marketplace_order_id)?.push(i);

        let list = orders.map(o => {
            const mine = byOrder.get(o.id);
            return {
                ...o, site_count: mine.length, ...summarize(mine),
                types: { gp: mine.filter(i => i.order_type === 'Guest Post').length, ne: mine.filter(i => i.order_type === 'Niche Edit').length },
                domains: mine.map(i => i.root_domain).filter(Boolean),
                _text: [o.order_number, ...mine.flatMap(i => [i.root_domain, i.anchor_text, i.target_url])].join(' ').toLowerCase()
            };
        });
        if (search) list = list.filter(o => o._text.includes(search));

        // Tab counts + headline numbers (before the status filter)
        const tabs = { all: list.length, placed: 0, in_progress: 0, completed: 0, cancelled: 0 };
        for (const o of list) tabs[o.status] = (tabs[o.status] || 0) + 1;
        const all = list.flatMap(o => byOrder.get(o.id));
        const stats = {
            orders: list.length,
            links: all.length,
            live: all.filter(i => i.status === 'live').length,
            in_flight: all.filter(i => ['placed', 'in_progress', 'publishing'].includes(i.status)).length,
            spent: list.reduce((s, o) => s + o.total_price, 0)
        };

        if (tabs[status] !== undefined && status !== 'all') list = list.filter(o => o.status === status);
        const total = list.length;
        res.json({
            orders: list.slice((page - 1) * limit, page * limit).map(({ _text, ...o }) => o),
            tabs, stats,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        });
    } catch (error) {
        next(error);
    }
};

/** @route GET /api/marketplace/:marketplace/orders/:id */
const getOrder = async (req, res, next) => {
    try {
        const order = (await query(
            `SELECT id, order_number, total_price::float AS total_price, created_at FROM marketplace_orders
             WHERE id = $1 AND client_user_id = $2 AND marketplace = $3`,
            [req.params.id, req.client.id, marketplaceOf(req)]
        )).rows[0];
        if (!order) return bad(res, 'Order not found', 404);
        const items = (await query(`${orderItemsSql} WHERE co.marketplace_order_id = $1 ORDER BY cod.id`, [order.id])).rows
            .map(i => ({ ...i, price: Number(i.price) }));
        res.json({ order: { ...order, ...summarize(items) }, items });
    } catch (error) {
        next(error);
    }
};

// ─── Wallet: PayPal + Razorpay ────────────────────────────────────────

// ₹ per $1 for Razorpay top-ups in India – set by admin (Marketplace Pricing), so prices don't move on their own
const INR_RATE_KEY = 'inr_per_usd';
const getInrRate = async () => {
    const v = Number((await query(`SELECT value FROM marketplace_plan_settings WHERE key = $1`, [INR_RATE_KEY])).rows[0]?.value);
    return v > 0 ? v : null;
};

// Fees added on top of a top-up – the wallet always gets the amount the client chose. Admin can change them.
const FEE_DEFAULTS = { razorpay_gst_pct: 18, razorpay_fee_pct: 2, paypal_fee_pct: 6.5 };
const getFeeSettings = async () => {
    const rows = (await query(`SELECT key, value FROM marketplace_plan_settings WHERE key = ANY($1)`, [Object.keys(FEE_DEFAULTS)])).rows;
    const fees = { ...FEE_DEFAULTS };
    for (const r of rows) { const v = Number(r.value); if (r.value !== null && v >= 0 && v <= 50) fees[r.key] = v; }
    return fees;
};
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * What the client pays for a $ top-up:
 *  razorpay (India) → ₹ amount, + GST on the amount, + payment fee on (amount + GST)
 *  paypal (abroad)  → $ amount + platform fee, no GST
 * → { currency, base, tax, fee, total } in the paid currency
 */
const priceTopup = (amountUsd, method, rate, fees) => {
    if (method === 'razorpay') {
        const base = r2(amountUsd * rate);
        const tax = r2(base * fees.razorpay_gst_pct / 100);
        const fee = r2((base + tax) * fees.razorpay_fee_pct / 100);
        return { currency: 'INR', base, tax, fee, total: r2(base + tax + fee) };
    }
    const fee = r2(amountUsd * fees.paypal_fee_pct / 100);
    return { currency: 'USD', base: amountUsd, tax: 0, fee, total: r2(amountUsd + fee) };
};

/**
 * Payment options for a client's country – one method each:
 *  India   → Razorpay in ₹ (+ GST + payment fee)
 *  Abroad  → PayPal in $ (+ platform fee)
 */
const paymentOptions = async (countryCode) => {
    const india = countryCode === 'IN';
    const [rate, fees] = await Promise.all([getInrRate(), getFeeSettings()]);
    return {
        country_code: countryCode || null,
        country: countryName(countryCode),
        needs_country: !countryCode,
        paypal: {
            available: !!countryCode && !india && paypal.isConfigured(),
            configured: paypal.isConfigured(),
            client_id: paypal.isConfigured() ? paypal.clientId() : null,
            mode: paypal.mode(),
            currency: 'USD',
            fee_pct: fees.paypal_fee_pct
        },
        razorpay: {
            available: india && razorpay.isConfigured() && !!rate,
            configured: razorpay.isConfigured(),
            mode: razorpay.mode(),
            currency: 'INR',
            inr_per_usd: india ? rate : null,
            gst_pct: fees.razorpay_gst_pct,
            fee_pct: fees.razorpay_fee_pct
        },
        _rate: rate,
        _fees: fees
    };
};
// the two internal fields stay on the server
const publicOptions = ({ _rate, _fees, ...o }) => o;

const clientCountry = async (clientId) => (await query(`SELECT country_code FROM users WHERE id = $1`, [clientId])).rows[0]?.country_code || null;

/**
 * Credit a top-up exactly once: only the first call flips the payment pending → completed,
 * adds the $ amount to the wallet (a 12-month lot – the remark must say "top-up") and applies the Pro rule.
 * `done` = { sql: 'col = $1', value } for the provider's capture / payment id. Returns null when already credited.
 */
const creditTopup = (payment, done, remark) => transaction(async (client) => {
    const flipped = (await client.query(
        `UPDATE client_payments SET status = 'completed', ${done.sql}, updated_at = NOW()
         WHERE id = $2 AND status = 'pending' RETURNING id`,
        [done.value, payment.id]
    )).rows[0];
    if (!flipped) return null;
    let wallet = (await client.query(`SELECT id FROM wallets WHERE user_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE`, [payment.client_user_id])).rows[0];
    if (!wallet) wallet = (await client.query(`INSERT INTO wallets (user_id, balance, created_at, updated_at) VALUES ($1,0,NOW(),NOW()) RETURNING id`, [payment.client_user_id])).rows[0];
    await client.query(`UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2`, [payment.amount, wallet.id]);
    await client.query(
        `INSERT INTO wallet_histories (wallet_id, type, price, remarks, status, created_at, updated_at, approved_date)
         VALUES ($1,'Credit',$2,$3,1,NOW(),NOW(),NOW())`,
        [wallet.id, payment.amount, remark]
    );
    // Same transaction: a $499+ top-up switches Pro on (once, for life)
    return await plans.applyTopup(client, payment.client_user_id, payment.amount);
});

/** The response after a top-up: new balance, plan and message (+ the Pro email once) */
const topupResult = async (clientId, amount, credited) => {
    const w = (await query(`SELECT COALESCE(balance, 0) AS balance FROM wallets WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [clientId])).rows[0];
    const plan = await plans.getPlan(clientId);
    let message = credited ? `$${Number(amount).toFixed(2)} added to your wallet` : 'Payment already added to your wallet';
    if (credited?.became_pro) {
        message += ' – you are now on Pro, for life';
        sendPlanEmailTo(clientId, 'pro').catch(err => console.error('[Marketplace] Pro email failed:', err.message));
    }
    return { message, wallet_balance: Number(w?.balance || 0), plan, became_pro: !!credited?.became_pro };
};

const topupAmount = (raw) => Math.round(Number(raw) * 100) / 100;
/** Before Pro the first top-up must be $499+ (it unlocks Pro); after that any amount from $10 */
const topupLimits = async (clientId) => {
    const pro = await plans.isPro(clientId);
    return { min: pro ? TOPUP_MIN : plans.PRO_PRICE, max: TOPUP_MAX, first_topup: !pro };
};
const checkAmount = async (res, clientId, amount) => {
    const lim = await topupLimits(clientId);
    if (amount >= lim.min && amount <= lim.max) return true;
    bad(res, lim.first_topup
        ? `Your first top-up must be at least $${lim.min} – it unlocks Pro and ordering`
        : `Please enter an amount between $${lim.min} and $${lim.max}`);
    return false;
};

/** @route GET /api/marketplace/:marketplace/wallet */
const getWallet = async (req, res, next) => {
    try {
        const w = (await query(`SELECT id, COALESCE(balance, 0) AS balance FROM wallets WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [req.client.id])).rows[0];
        const history = w ? (await query(
            `SELECT id, type, price::float AS amount, remarks, created_at FROM wallet_histories WHERE wallet_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
            [w.id]
        )).rows : [];
        const totals = w ? (await query(
            `SELECT COALESCE(SUM(CASE WHEN LOWER(type) = 'credit' AND remarks ILIKE '%top-up%' THEN price END), 0)::float AS added,
                    COALESCE(SUM(CASE WHEN LOWER(type) = 'debit' AND remarks NOT LIKE '${plans.EXPIRED_REMARK}%' THEN price END), 0)::float AS spent,
                    COALESCE(SUM(CASE WHEN LOWER(type) = 'credit' AND remarks NOT ILIKE '%top-up%' THEN price END), 0)::float AS refunded,
                    COALESCE(SUM(CASE WHEN LOWER(type) = 'debit' AND remarks LIKE '${plans.EXPIRED_REMARK}%' THEN price END), 0)::float AS expired
             FROM wallet_histories WHERE wallet_id = $1`, [w.id]
        )).rows[0] : { added: 0, spent: 0, refunded: 0, expired: 0 };
        const options = await paymentOptions(await clientCountry(req.client.id));
        res.json({
            balance: Number(w?.balance || 0),
            totals,
            funds: await plans.walletFunds(req.client.id),
            history,
            ...publicOptions(options),
            topup_limits: await topupLimits(req.client.id)
        });
    } catch (error) {
        next(error);
    }
};

/** @route POST /api/marketplace/:marketplace/wallet/paypal/create  { amount } → { paypal_order_id } */
const createPaypalTopup = async (req, res, next) => {
    try {
        if (!paypal.isConfigured()) return res.status(503).json({ error: 'Not Configured', message: 'PayPal is not set up yet' });
        const options = await paymentOptions(await clientCountry(req.client.id));
        if (options.needs_country) return bad(res, 'Please add your country in your profile first');
        if (!options.paypal.available) return bad(res, 'PayPal isn\'t available for your country – please use Razorpay');
        const amount = topupAmount(req.body.amount);
        if (!(await checkAmount(res, req.client.id, amount))) return;
        const price = priceTopup(amount, 'paypal', null, options._fees); // amount + platform fee
        const paypalOrderId = await paypal.createOrder(price.total, `wallet-${req.client.id}-${Date.now()}`);
        await query(
            `INSERT INTO client_payments (client_user_id, amount, currency, status, provider, paypal_order_id, paid_amount, paid_currency, tax_amount, fee_amount, created_at, updated_at)
             VALUES ($1,$2,'USD','pending','paypal',$3,$4,'USD',0,$5,NOW(),NOW())`,
            [req.client.id, amount, paypalOrderId, price.total, price.fee]
        );
        res.json({ paypal_order_id: paypalOrderId, amount, fee: price.fee, total: price.total });
    } catch (error) {
        next(error);
    }
};

/**
 * @route POST /api/marketplace/:marketplace/wallet/paypal/capture  { paypal_order_id }
 * Captures the approved payment and credits the wallet exactly once.
 */
const capturePaypalTopup = async (req, res, next) => {
    try {
        const paypalOrderId = String(req.body.paypal_order_id || '');
        const payment = (await query(
            `SELECT * FROM client_payments WHERE paypal_order_id = $1 AND client_user_id = $2`, [paypalOrderId, req.client.id]
        )).rows[0];
        if (!payment) return bad(res, 'Payment not found', 404);
        if (payment.status === 'completed') return res.json({ message: 'Payment already added to your wallet', already: true });

        const cap = await paypal.captureOrder(paypalOrderId);
        const charged = Number(payment.paid_amount ?? payment.amount); // amount + platform fee
        if (cap.status !== 'COMPLETED' || cap.currency !== 'USD' || Math.abs(Number(cap.amount) - charged) > 0.009) {
            await query(`UPDATE client_payments SET status = 'failed', updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [payment.id]);
            return bad(res, `PayPal did not complete the payment (status: ${cap.status || 'unknown'}). You have not been charged by us.`);
        }
        const fee = Number(payment.fee_amount || 0);
        const credited = await creditTopup(payment, { sql: 'paypal_capture_id = $1', value: cap.captureId },
            `Wallet top-up via PayPal – paid $${charged.toFixed(2)}${fee ? ` incl. $${fee.toFixed(2)} platform fee` : ''} (${cap.captureId || paypalOrderId})`);
        res.json(await topupResult(req.client.id, payment.amount, credited));
    } catch (error) {
        next(error);
    }
};

/**
 * @route POST /api/marketplace/:marketplace/wallet/razorpay/create  { amount }  ($ for the wallet)
 * India only: ₹ at the admin's rate + GST + payment fee. → what the Razorpay popup needs
 */
const createRazorpayTopup = async (req, res, next) => {
    try {
        if (!razorpay.isConfigured()) return res.status(503).json({ error: 'Not Configured', message: 'Razorpay is not set up yet' });
        // Safety: live keys (real money) only on the live server, never on a local / test machine
        const onRailway = !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
        if (razorpay.mode() === 'live' && !onRailway) return res.status(503).json({ error: 'Not Configured', message: 'Live Razorpay keys are only used on the live server – use test keys (rzp_test_…) locally' });
        const options = await paymentOptions(await clientCountry(req.client.id));
        if (options.needs_country) return bad(res, 'Please add your country in your profile first');
        if (!options.razorpay.available) return bad(res, 'Razorpay is only for clients in India – please use PayPal');
        const amount = topupAmount(req.body.amount);
        if (!(await checkAmount(res, req.client.id, amount))) return;

        const price = priceTopup(amount, 'razorpay', options._rate, options._fees); // ₹ amount + GST + fee
        const minor = Math.round(price.total * 100);                                // paise
        const order = await razorpay.createOrder(minor, price.currency, `mp-${req.client.id}-${Date.now()}`,
            { client_id: String(req.client.id), wallet_usd: amount.toFixed(2), gst_inr: price.tax.toFixed(2), fee_inr: price.fee.toFixed(2), marketplace: marketplaceOf(req) });
        await query(
            `INSERT INTO client_payments (client_user_id, amount, currency, status, provider, razorpay_order_id, paid_amount, paid_currency, tax_amount, fee_amount, created_at, updated_at)
             VALUES ($1,$2,'USD','pending','razorpay',$3,$4,$5,$6,$7,NOW(),NOW())`,
            [req.client.id, amount, order.id, price.total, price.currency, price.tax, price.fee]
        );
        res.json({
            key_id: razorpay.keyId(),
            order_id: order.id,
            amount: minor,
            currency: price.currency,
            wallet_amount: amount,
            paid_amount: price.total,
            breakdown: price,
            name: mp.getBrand(marketplaceOf(req)).name,
            prefill: { name: req.client.name, email: req.client.email }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Check a Razorpay payment with Razorpay itself (never the browser): right order, captured, right amount.
 * Captures it first when the account doesn't auto-capture. → { ok, payment, reason }
 */
const checkRazorpayPayment = async (payment, paymentId) => {
    let p = await razorpay.fetchPayment(paymentId);
    const minor = Math.round(Number(payment.paid_amount) * 100);
    if (p.order_id !== payment.razorpay_order_id) return { ok: false, reason: 'This payment belongs to another order' };
    if (p.status === 'authorized') p = await razorpay.capturePayment(paymentId, minor, payment.paid_currency);
    if (p.status !== 'captured') return { ok: false, reason: `Razorpay did not complete the payment (status: ${p.status || 'unknown'})` };
    if (Number(p.amount) !== minor || p.currency !== payment.paid_currency) return { ok: false, reason: 'The paid amount does not match this top-up' };
    return { ok: true, payment: p };
};

const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const razorpayRemark = (payment, paymentId) => {
    const extras = Number(payment.tax_amount || 0) || Number(payment.fee_amount || 0) ? ' incl. GST & payment fee' : '';
    return `Wallet top-up via Razorpay – paid ${inr(payment.paid_amount)}${extras} (${paymentId})`;
};

/**
 * @route POST /api/marketplace/:marketplace/wallet/razorpay/verify  { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * Checks the popup's signature, then the payment with Razorpay, and credits the wallet exactly once.
 */
const verifyRazorpayTopup = async (req, res, next) => {
    try {
        const orderId = String(req.body.razorpay_order_id || '');
        const paymentId = String(req.body.razorpay_payment_id || '');
        const signature = String(req.body.razorpay_signature || '');
        const payment = (await query(
            `SELECT * FROM client_payments WHERE provider = 'razorpay' AND razorpay_order_id = $1 AND client_user_id = $2`, [orderId, req.client.id]
        )).rows[0];
        if (!payment) return bad(res, 'Payment not found', 404);
        if (payment.status === 'completed') return res.json({ ...(await topupResult(req.client.id, payment.amount, null)), already: true });
        if (!razorpay.verifyPaymentSignature(orderId, paymentId, signature)) {
            return bad(res, 'Payment could not be verified – if money was taken, it will be added automatically or refunded by Razorpay');
        }
        const check = await checkRazorpayPayment(payment, paymentId);
        if (!check.ok) return bad(res, `${check.reason}. You have not been charged by us.`);
        const credited = await creditTopup(payment, { sql: 'razorpay_payment_id = $1', value: paymentId }, razorpayRemark(payment, paymentId));
        res.json(await topupResult(req.client.id, payment.amount, credited));
    } catch (error) {
        next(error);
    }
};

/**
 * @route POST /api/marketplace/razorpay/webhook   (Razorpay → us; raw body, X-Razorpay-Signature)
 * Backup for a closed browser: payment.captured / order.paid credit the wallet if verify never ran.
 * Events we can't use still get 200, so Razorpay doesn't keep retrying them.
 */
const razorpayWebhook = async (req, res) => {
    try {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
        if (!razorpay.verifyWebhookSignature(raw, req.get('x-razorpay-signature'))) return res.status(400).json({ error: 'Bad signature' });
        const event = JSON.parse(raw.toString('utf8'));
        if (!['payment.captured', 'order.paid'].includes(event.event)) return res.json({ ok: true, ignored: event.event });
        const p = event.payload?.payment?.entity;
        if (!p?.order_id || !p?.id) return res.json({ ok: true, ignored: 'no payment' });
        const payment = (await query(`SELECT * FROM client_payments WHERE provider = 'razorpay' AND razorpay_order_id = $1`, [p.order_id])).rows[0];
        if (!payment || payment.status === 'completed') return res.json({ ok: true });
        const check = await checkRazorpayPayment(payment, p.id);
        if (!check.ok) {
            console.error(`[Razorpay webhook] payment ${p.id} not credited: ${check.reason}`);
            return res.json({ ok: true, credited: false });
        }
        const credited = await creditTopup(payment, { sql: 'razorpay_payment_id = $1', value: p.id }, razorpayRemark(payment, p.id));
        if (credited?.became_pro) sendPlanEmailTo(payment.client_user_id, 'pro').catch(err => console.error('[Marketplace] Pro email failed:', err.message));
        res.json({ ok: true, credited: !!credited });
    } catch (error) {
        console.error('[Razorpay webhook]', error.message);
        res.status(500).json({ error: 'Webhook failed' }); // Razorpay retries later
    }
};

/** @route GET /api/marketplace/:marketplace/countries – for signup + profile */
const getCountries = (req, res) => res.json({ countries: COUNTRIES.map(([code, name]) => ({ code, name })) });

// ─── Notifications ────────────────────────────────────────────────────

/** @route GET /api/marketplace/:marketplace/notifications */
const getNotifications = async (req, res, next) => {
    try {
        const rows = (await query(
            `SELECT id, type, data, read_at, created_at FROM notifications
             WHERE notifiable_id = $1 AND notifiable_type = 'App\\Models\\User' ORDER BY created_at DESC LIMIT 50`,
            [req.client.id]
        )).rows.map(n => { let data = {}; try { data = JSON.parse(n.data); } catch { /* keep {} */ } return { ...n, data }; });
        res.json({ notifications: rows, unread: rows.filter(n => !n.read_at).length });
    } catch (error) {
        next(error);
    }
};

/** @route POST /api/marketplace/:marketplace/notifications/read  { id? } (no id = all) */
const markNotificationsRead = async (req, res, next) => {
    try {
        if (req.body.id) {
            await query(`UPDATE notifications SET read_at = NOW() WHERE id = $1 AND notifiable_id = $2 AND read_at IS NULL`, [req.body.id, req.client.id]);
        } else {
            await query(`UPDATE notifications SET read_at = NOW() WHERE notifiable_id = $1 AND notifiable_type = 'App\\Models\\User' AND read_at IS NULL`, [req.client.id]);
        }
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
};

// ─── Dashboard / transactions / profile ───────────────────────────────

const walletOf = async (clientId) =>
    (await query(`SELECT id, COALESCE(balance, 0) AS balance FROM wallets WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [clientId])).rows[0];

/** @route GET /api/marketplace/:marketplace/dashboard – overview numbers for the client */
const getDashboard = async (req, res, next) => {
    try {
        const marketplace = marketplaceOf(req);
        const w = await walletOf(req.client.id);
        const [orderCount, items, money, recent, activity] = await Promise.all([
            query(`SELECT COUNT(*) AS c FROM marketplace_orders WHERE client_user_id = $1 AND marketplace = $2`, [req.client.id, marketplace]),
            query(`${orderItemsSql} JOIN marketplace_orders mo ON mo.id = co.marketplace_order_id
                   WHERE mo.client_user_id = $1 AND mo.marketplace = $2 ORDER BY cod.id DESC`, [req.client.id, marketplace]),
            w ? query(
                `SELECT COALESCE(SUM(CASE WHEN LOWER(type) = 'credit' AND remarks ILIKE '%top-up%' THEN price END), 0)::float AS added,
                        COALESCE(SUM(CASE WHEN LOWER(type) = 'debit' AND remarks NOT LIKE '${plans.EXPIRED_REMARK}%' THEN price END), 0)::float AS spent,
                        COALESCE(SUM(CASE WHEN LOWER(type) = 'credit' AND remarks NOT ILIKE '%top-up%' THEN price END), 0)::float AS refunded,
                        COALESCE(SUM(CASE WHEN LOWER(type) = 'debit' AND remarks LIKE '${plans.EXPIRED_REMARK}%' THEN price END), 0)::float AS expired
                 FROM wallet_histories WHERE wallet_id = $1`, [w.id]) : Promise.resolve({ rows: [{ added: 0, spent: 0, refunded: 0, expired: 0 }] }),
            query(`SELECT id, order_number, total_price::float AS total_price, created_at FROM marketplace_orders
                   WHERE client_user_id = $1 AND marketplace = $2 ORDER BY created_at DESC LIMIT 5`, [req.client.id, marketplace]),
            // Last 6 months: amount paid for orders + links ordered
            query(`SELECT to_char(m, 'YYYY-MM') AS month,
                          COALESCE((SELECT SUM(total_price) FROM marketplace_orders mo
                                    WHERE mo.client_user_id = $1 AND mo.marketplace = $2 AND date_trunc('month', mo.created_at) = m), 0)::float AS spent,
                          (SELECT COUNT(*) FROM marketplace_orders mo
                           JOIN client_orders co ON co.marketplace_order_id = mo.id
                           JOIN client_order_details cod ON cod.client_order_id = co.id
                           WHERE mo.client_user_id = $1 AND mo.marketplace = $2 AND date_trunc('month', mo.created_at) = m)::int AS links
                   FROM generate_series(date_trunc('month', NOW()) - interval '5 months', date_trunc('month', NOW()), interval '1 month') m
                   ORDER BY m`, [req.client.id, marketplace])
        ]);
        const all = items.rows;
        const { counts } = summarize(all);
        const recentOrders = recent.rows.map(o => {
            const mine = all.filter(i => i.marketplace_order_id === o.id);
            return { ...o, site_count: mine.length, ...summarize(mine) };
        });
        res.json({
            balance: Number(w?.balance || 0),
            orders: parseInt(orderCount.rows[0].c),
            links: { total: all.length, ...counts },
            money: money.rows[0],
            recent_orders: recentOrders,
            activity: activity.rows,
            recent_live: all.filter(i => i.status === 'live').slice(0, 5)
                .map(i => ({ id: i.id, root_domain: i.root_domain, live_url: i.live_url, order_type: i.order_type, anchor_text: i.anchor_text }))
        });
    } catch (error) {
        next(error);
    }
};

/** @route GET /api/marketplace/:marketplace/transactions?page&limit&type=credit|debit&search */
const getTransactions = async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const w = await walletOf(req.client.id);
        const empty = { transactions: [], summary: { credited: 0, debited: 0, count: 0 }, pagination: { page, limit, total: 0, totalPages: 0 } };
        if (!w) return res.json(empty);

        const params = [w.id];
        const where = ['wallet_id = $1'];
        const type = String(req.query.type || '').toLowerCase();
        if (type === 'credit' || type === 'debit') { params.push(type); where.push(`LOWER(type) = $${params.length}`); }
        const search = String(req.query.search || '').trim();
        if (search) { params.push(`%${search}%`); where.push(`remarks ILIKE $${params.length}`); }
        const whereSql = where.join(' AND ');

        const summary = (await query(
            `SELECT COUNT(*)::int AS count,
                    COALESCE(SUM(CASE WHEN LOWER(type) = 'credit' THEN price END), 0)::float AS credited,
                    COALESCE(SUM(CASE WHEN LOWER(type) = 'debit' THEN price END), 0)::float AS debited
             FROM wallet_histories WHERE ${whereSql}`, params
        )).rows[0];
        const rows = (await query(
            `SELECT id, LOWER(type) AS type, price::float AS amount, remarks, created_at FROM wallet_histories
             WHERE ${whereSql} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, (page - 1) * limit]
        )).rows;
        res.json({ transactions: rows, summary, pagination: { page, limit, total: summary.count, totalPages: Math.ceil(summary.count / limit) } });
    } catch (error) {
        next(error);
    }
};

const PROFILE_FIELDS = ['name', 'mobile_number', 'whatsapp', 'skype', 'address'];

/** @route GET /api/marketplace/:marketplace/profile */
const getProfile = async (req, res, next) => {
    try {
        const u = (await query(
            `SELECT id, name, email, mobile_number, whatsapp, skype, address, country_code, created_at, last_login FROM users WHERE id = $1`, [req.client.id]
        )).rows[0];
        res.json({ profile: u });
    } catch (error) {
        next(error);
    }
};

/** @route PUT /api/marketplace/:marketplace/profile  { name, country_code, mobile_number, whatsapp, skype, address } (email can't change) */
const updateProfile = async (req, res, next) => {
    try {
        const v = {};
        for (const f of PROFILE_FIELDS) v[f] = String(req.body[f] ?? '').trim();
        if (v.name.length < 2) return bad(res, 'Please enter your name (at least 2 characters)');
        if (v.name.length > 100) return bad(res, 'Name is too long');
        for (const f of ['mobile_number', 'whatsapp', 'skype']) if (v[f].length > 50) return bad(res, 'Contact details are too long');
        if (v.address.length > 500) return bad(res, 'Address is too long');
        const country = cleanCountry(req.body.country_code);
        if (!country) return bad(res, 'Please choose your country');
        const u = (await query(
            `UPDATE users SET name = $1, mobile_number = NULLIF($2, ''), whatsapp = NULLIF($3, ''), skype = NULLIF($4, ''), address = NULLIF($5, ''), country_code = $7, updated_at = NOW()
             WHERE id = $6 RETURNING id, name, email, mobile_number, whatsapp, skype, address, country_code, created_at, last_login`,
            [v.name, v.mobile_number, v.whatsapp, v.skype, v.address, req.client.id, country]
        )).rows[0];
        res.json({ message: 'Profile saved', profile: u });
    } catch (error) {
        next(error);
    }
};

/** @route PUT /api/marketplace/:marketplace/profile/password  { current_password, new_password, confirm_password } */
const changePassword = async (req, res, next) => {
    try {
        const { current_password, new_password, confirm_password } = req.body;
        if (!new_password || String(new_password).length < 8) return bad(res, 'New password must be at least 8 characters');
        if (new_password !== confirm_password) return bad(res, 'New passwords do not match');
        const u = (await query(`SELECT password FROM users WHERE id = $1`, [req.client.id])).rows[0];
        if (!(await bcrypt.compare(String(current_password || ''), u?.password || ''))) return bad(res, 'Your current password is wrong');
        if (await bcrypt.compare(String(new_password), u.password)) return bad(res, 'New password must be different from the current one');
        await query(`UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2`, [await bcrypt.hash(String(new_password), 10), req.client.id]);
        res.json({ message: 'Password changed' });
    } catch (error) {
        next(error);
    }
};

// ─── Plan (Free / Pro) ────────────────────────────────────────────────

/** @route GET /api/marketplace/:marketplace/plan – current plan, wallet money by expiry date and plan history */
const getMyPlan = async (req, res, next) => {
    try {
        const plan = await plans.getPlan(req.client.id);
        const history = (await query(
            `SELECT kind, amount::float AS amount, note, created_at
             FROM marketplace_plan_events WHERE client_user_id = $1 AND kind IN ('pro', 'grant', 'expired', 'deactivated', 'reactivated')
             ORDER BY created_at DESC LIMIT 30`, [req.client.id]
        )).rows;
        const free = await plans.freeDomains(marketplaceOf(req));
        res.json({ plan, history, free_sites: free.length });
    } catch (error) {
        next(error);
    }
};

// ─── Projects (the client's own websites + competitors) ───────────────

const MAX_COMPETITORS = 3;
const metricsView = (m) => (m ? {
    authority: m.opr_score, global_rank: m.opr_rank, status: m.status, checked_at: m.fetched_at,
    da: m.da ?? null, dr: m.dr ?? null, traffic: m.traffic ?? null
} : null);

/** Competitor list from the request: cleaned, deduplicated, not the project itself, max 3 */
const cleanCompetitors = (list, ownDomain) => {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        if (!String(raw || '').trim()) continue;
        const d = domainMetrics.normalizeDomain(raw);
        if (!d) return { error: `"${String(raw).slice(0, 60)}" is not a valid domain (e.g. competitor.com)` };
        if (d !== ownDomain && !out.includes(d)) out.push(d);
    }
    if (out.length > MAX_COMPETITORS) return { error: `You can add up to ${MAX_COMPETITORS} competitors` };
    return { list: out };
};

const projectRow = async (req, id) => (await query(
    `SELECT id, domain, created_at FROM marketplace_projects WHERE id = $1 AND client_user_id = $2 AND marketplace = $3`,
    [id, req.client.id, marketplaceOf(req)]
)).rows[0];

/** @route GET /api/marketplace/:marketplace/projects – folders with order stats + cached metrics */
const getProjects = async (req, res, next) => {
    try {
        await mp.ensureSchema();
        const projects = (await query(
            `SELECT p.id, p.domain, p.created_at,
                    (SELECT COUNT(*)::int FROM marketplace_project_competitors c WHERE c.project_id = p.id) AS competitors,
                    COUNT(cod.id)::int AS links,
                    COUNT(DISTINCT co.marketplace_order_id)::int AS orders,
                    COALESCE(SUM(cod.price), 0)::float AS spent,
                    MAX(co.created_at) AS last_order_at
             FROM marketplace_projects p
             LEFT JOIN client_order_details cod ON cod.project_id = p.id
             LEFT JOIN client_orders co ON co.id = cod.client_order_id AND co.client_user_id = p.client_user_id
             WHERE p.client_user_id = $1 AND p.marketplace = $2
             GROUP BY p.id ORDER BY p.created_at DESC`,
            [req.client.id, marketplaceOf(req)]
        )).rows;
        // Live links per project (same status rules as My Orders)
        const live = projects.length ? (await query(
            `SELECT x.project_id, COUNT(*) FILTER (WHERE x.status = 'live')::int AS live
             FROM (${orderItemsSql.replace('SELECT cod.id,', 'SELECT cod.project_id, cod.id,')} WHERE cod.project_id = ANY($1::int[])) x
             GROUP BY x.project_id`, [projects.map(p => p.id)]
        )).rows : [];
        const liveBy = new Map(live.map(r => [r.project_id, r.live]));
        const metrics = await domainMetrics.getMetrics(projects.map(p => p.domain));
        res.json({
            projects: projects.map(p => ({ ...p, live: liveBy.get(p.id) || 0, metrics: metricsView(metrics.get(p.domain)) })),
            metrics_source: process.env.OPENPAGERANK_API_KEY ? 'openpagerank' : null
        });
    } catch (error) {
        next(error);
    }
};

/** @route POST /api/marketplace/:marketplace/projects  { domain, competitors?: [] } */
const createProject = async (req, res, next) => {
    try {
        await mp.ensureSchema();
        const domain = domainMetrics.normalizeDomain(req.body.domain);
        if (!domain) return bad(res, 'Please enter your website domain, e.g. abc.com');
        const comp = cleanCompetitors(req.body.competitors, domain);
        if (comp.error) return bad(res, comp.error);
        const existing = (await query(`SELECT id FROM marketplace_projects WHERE client_user_id = $1 AND domain = $2`, [req.client.id, domain])).rows[0];
        if (existing) return res.status(200).json({ message: `${domain} is already one of your projects`, project: { id: existing.id, domain }, existing: true });
        const project = await transaction(async (tx) => {
            const p = (await tx.query(
                `INSERT INTO marketplace_projects (marketplace, client_user_id, domain) VALUES ($1,$2,$3) RETURNING id, domain, created_at`,
                [marketplaceOf(req), req.client.id, domain]
            )).rows[0];
            for (const c of comp.list) await tx.query(`INSERT INTO marketplace_project_competitors (project_id, domain) VALUES ($1,$2)`, [p.id, c]);
            return p;
        });
        const metrics = await domainMetrics.getMetrics([domain, ...comp.list]);
        res.status(201).json({ message: `Project ${domain} created`, project: { ...project, metrics: metricsView(metrics.get(domain)) } });
    } catch (error) {
        next(error);
    }
};

/** @route GET /api/marketplace/:marketplace/projects/:id – metrics, competitors and full purchase history */
const getProject = async (req, res, next) => {
    try {
        const p = await projectRow(req, req.params.id);
        if (!p) return bad(res, 'Project not found', 404);
        const competitors = (await query(`SELECT id, domain FROM marketplace_project_competitors WHERE project_id = $1 ORDER BY id`, [p.id])).rows;
        const metrics = await domainMetrics.getMetrics([p.domain, ...competitors.map(c => c.domain)]);
        const items = (await query(
            `${orderItemsSql}
             JOIN marketplace_orders mo ON mo.id = co.marketplace_order_id
             WHERE cod.project_id = $1 AND co.client_user_id = $2
             ORDER BY mo.created_at DESC, cod.id`,
            [p.id, req.client.id]
        )).rows;
        const orders = (await query(
            `SELECT mo.id, mo.order_number, mo.created_at FROM marketplace_orders mo
             WHERE mo.id = ANY($1::int[]) ORDER BY mo.created_at DESC`, [[...new Set(items.map(i => i.marketplace_order_id))]]
        )).rows;
        const byOrder = new Map(orders.map(o => [o.id, o]));
        const history = items.map(i => ({ ...i, price: Number(i.price), order_number: byOrder.get(i.marketplace_order_id)?.order_number, ordered_at: byOrder.get(i.marketplace_order_id)?.created_at }));
        const { counts } = summarize(history);
        res.json({
            project: { ...p, metrics: metricsView(metrics.get(p.domain)) },
            competitors: competitors.map(c => ({ ...c, metrics: metricsView(metrics.get(c.domain)) })),
            stats: {
                orders: orders.length, links: history.length, live: counts.live,
                in_progress: counts.placed + counts.in_progress + counts.publishing, cancelled: counts.cancelled,
                spent: Math.round(history.filter(i => i.status !== 'cancelled').reduce((s, i) => s + i.price, 0) * 100) / 100,
                guest_posts: history.filter(i => i.order_type === 'Guest Post').length,
                niche_edits: history.filter(i => i.order_type === 'Niche Edit').length
            },
            history,
            max_competitors: MAX_COMPETITORS
        });
    } catch (error) {
        next(error);
    }
};

/** @route PUT /api/marketplace/:marketplace/projects/:id/competitors  { competitors: [] } (replaces the list) */
const updateCompetitors = async (req, res, next) => {
    try {
        const p = await projectRow(req, req.params.id);
        if (!p) return bad(res, 'Project not found', 404);
        const comp = cleanCompetitors(req.body.competitors, p.domain);
        if (comp.error) return bad(res, comp.error);
        await transaction(async (tx) => {
            await tx.query(`DELETE FROM marketplace_project_competitors WHERE project_id = $1`, [p.id]);
            for (const c of comp.list) await tx.query(`INSERT INTO marketplace_project_competitors (project_id, domain) VALUES ($1,$2)`, [p.id, c]);
        });
        await domainMetrics.getMetrics(comp.list);
        res.json({ message: 'Competitors saved' });
    } catch (error) {
        next(error);
    }
};

/** @route POST /api/marketplace/:marketplace/projects/:id/refresh – re-check metrics (free source, at most once a day per domain) */
const refreshProjectMetrics = async (req, res, next) => {
    try {
        const p = await projectRow(req, req.params.id);
        if (!p) return bad(res, 'Project not found', 404);
        const competitors = (await query(`SELECT domain FROM marketplace_project_competitors WHERE project_id = $1`, [p.id])).rows.map(c => c.domain);
        await domainMetrics.getMetrics([p.domain, ...competitors], { force: true });
        res.json({ message: 'Metrics updated' });
    } catch (error) {
        next(error);
    }
};

/** @route DELETE /api/marketplace/:marketplace/projects/:id – only projects without orders */
const deleteProject = async (req, res, next) => {
    try {
        const p = await projectRow(req, req.params.id);
        if (!p) return bad(res, 'Project not found', 404);
        const used = (await query(`SELECT 1 FROM client_order_details WHERE project_id = $1 LIMIT 1`, [p.id])).rows.length;
        if (used) return bad(res, 'This project has orders, so it is kept for your purchase history');
        await query(`UPDATE marketplace_cart_items SET project_id = NULL WHERE project_id = $1 AND client_user_id = $2`, [p.id, req.client.id]);
        await query(`DELETE FROM marketplace_projects WHERE id = $1`, [p.id]);
        res.json({ message: `Project ${p.domain} deleted` });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    requireActive,
    getMyPlan,
    getProjects, createProject, getProject, updateCompetitors, refreshProjectMetrics, deleteProject,
    getDashboard, getTransactions, getProfile, updateProfile, changePassword,
    uploadContent, getSitePosts, WRITING_FEES,
    checkMarketplace, requireClient,
    sendSignupCode, verifySignupCode, login, me,
    getSites, getCategories, getCart, addToCart, updateCartItem, removeCartItem, checkout,
    getOrders, getOrder, getWallet, createPaypalTopup, createRazorpayTopup, verifyRazorpayTopup, razorpayWebhook, getCountries, capturePaypalTopup,
    getNotifications, markNotificationsRead
};
