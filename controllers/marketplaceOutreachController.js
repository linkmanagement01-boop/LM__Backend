/**
 * Marketplace outreach requests
 * A Pro client searches for a domain we don't have → asks us to reach out to it, with a budget.
 * Client: create + see own requests (read-only). Admin / Manager: see all requests and set the status.
 */

const { query } = require('../config/database');
const plans = require('../utils/marketplacePlan');

const STATUSES = ['requested', 'in_progress', 'added', 'not_possible'];
const OPEN = ['requested', 'in_progress'];
const MAX_OPEN_PER_CLIENT = 50;
const MAX_BUDGET = 100000;

let ready = null;
const ensureSchema = () => (ready = ready || (async () => {
    await query(`
        CREATE TABLE IF NOT EXISTS marketplace_outreach_requests (
            id SERIAL PRIMARY KEY,
            marketplace VARCHAR(30) NOT NULL,
            client_user_id INT NOT NULL,
            domain VARCHAR(255) NOT NULL,
            budget NUMERIC(10,2) NOT NULL,
            note TEXT,
            status VARCHAR(20) NOT NULL DEFAULT 'requested',
            updated_by INT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await query(`CREATE INDEX IF NOT EXISTS mp_outreach_client_idx ON marketplace_outreach_requests (client_user_id, created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS mp_outreach_status_idx ON marketplace_outreach_requests (status, created_at DESC)`);
})().catch(err => { ready = null; throw err; }));

/** "https://www.Example.com/blog?x" → "example.com"; null when it isn't a domain */
const cleanDomain = (raw) => {
    const d = String(raw || '').trim().toLowerCase()
        .replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
    return /^(?=.{4,253}$)([a-z0-9](-*[a-z0-9])*)(\.[a-z0-9](-*[a-z0-9])*)+$/.test(d) && /\.[a-z]{2,}$/.test(d) ? d : null;
};

const bad = (res, message, code = 400) => res.status(code).json({ error: 'Validation Error', message });

const publicRow = (r) => ({
    id: r.id, domain: r.domain, budget: Number(r.budget), note: r.note || '', status: r.status,
    created_at: r.created_at, updated_at: r.updated_at
});

// ─── Client ──────────────────────────────────────────────────────────

/** @route POST /api/marketplace/:marketplace/outreach  { domain, budget, note? } – Pro clients only */
const createRequest = async (req, res, next) => {
    try {
        await ensureSchema();
        if (!(await plans.isPro(req.client.id))) {
            return res.status(403).json({ error: 'Pro Required', code: 'pro_required', message: 'Outreach requests are part of Pro – unlock Pro to send one' });
        }
        const domain = cleanDomain(req.body.domain);
        if (!domain) return bad(res, 'Please enter a valid domain, e.g. example.com');
        const budget = Math.round(Number(req.body.budget) * 100) / 100;
        if (!(budget >= 1 && budget <= MAX_BUDGET)) return bad(res, `Please enter a budget between $1 and $${MAX_BUDGET.toLocaleString('en-US')}`);
        const note = String(req.body.note || '').trim().slice(0, 500);

        const dup = (await query(
            `SELECT id FROM marketplace_outreach_requests WHERE client_user_id = $1 AND domain = $2 AND status = ANY($3) LIMIT 1`,
            [req.client.id, domain, OPEN]
        )).rows[0];
        if (dup) return bad(res, `You already have an open request for ${domain} – see Outreach`, 409);
        const open = Number((await query(
            `SELECT COUNT(*) AS c FROM marketplace_outreach_requests WHERE client_user_id = $1 AND status = ANY($2)`, [req.client.id, OPEN]
        )).rows[0].c);
        if (open >= MAX_OPEN_PER_CLIENT) return bad(res, `You have ${open} open requests – please wait until some are answered`, 429);

        const row = (await query(
            `INSERT INTO marketplace_outreach_requests (marketplace, client_user_id, domain, budget, note)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [req.params.marketplace, req.client.id, domain, budget, note || null]
        )).rows[0];
        res.status(201).json({ message: `Request sent – our outreach team will contact ${domain}`, request: publicRow(row) });
    } catch (error) {
        next(error);
    }
};

/**
 * @route POST /api/marketplace/:marketplace/outreach/bulk  { items: [{ domain, budget }], note? }  – Pro clients only
 * One request per domain (from a bulk search's "not found" list). Domains already open, or invalid, are skipped.
 */
const createBulk = async (req, res, next) => {
    try {
        await ensureSchema();
        if (!(await plans.isPro(req.client.id))) {
            return res.status(403).json({ error: 'Pro Required', code: 'pro_required', message: 'Outreach requests are part of Pro – unlock Pro to send one' });
        }
        const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 30) : [];
        if (!items.length) return bad(res, 'Add at least one domain');
        const note = String(req.body.note || '').trim().slice(0, 500);

        // Check everything first – nothing is created when a budget is missing
        const seen = new Set();
        const rows = [];
        const skipped = [];
        for (const it of items) {
            const domain = cleanDomain(it?.domain);
            const budget = Math.round(Number(it?.budget) * 100) / 100;
            if (!domain) { skipped.push({ domain: String(it?.domain || ''), reason: 'Not a valid domain' }); continue; }
            if (seen.has(domain)) continue;
            seen.add(domain);
            if (!(budget >= 1 && budget <= MAX_BUDGET)) return bad(res, `Please enter a budget between $1 and $${MAX_BUDGET.toLocaleString('en-US')} for ${domain}`);
            rows.push({ domain, budget });
        }
        const open = (await query(
            `SELECT domain FROM marketplace_outreach_requests WHERE client_user_id = $1 AND status = ANY($2)`, [req.client.id, OPEN]
        )).rows.map(r => r.domain);
        const fresh = rows.filter(r => {
            if (!open.includes(r.domain)) return true;
            skipped.push({ domain: r.domain, reason: 'Already requested' });
            return false;
        });
        if (open.length + fresh.length > MAX_OPEN_PER_CLIENT) {
            return bad(res, `You can have up to ${MAX_OPEN_PER_CLIENT} open requests – you have ${open.length} now`, 429);
        }

        const created = [];
        for (const r of fresh) {
            created.push(publicRow((await query(
                `INSERT INTO marketplace_outreach_requests (marketplace, client_user_id, domain, budget, note)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [req.params.marketplace, req.client.id, r.domain, r.budget, note || null]
            )).rows[0]));
        }
        res.status(created.length ? 201 : 200).json({
            message: created.length
                ? `${created.length} outreach request${created.length === 1 ? '' : 's'} sent to our team`
                : 'Nothing new to send – those domains are already requested',
            created, skipped
        });
    } catch (error) {
        next(error);
    }
};

/** @route GET /api/marketplace/:marketplace/outreach – the client's own requests, newest first */
const myRequests = async (req, res, next) => {
    try {
        await ensureSchema();
        const rows = (await query(
            `SELECT * FROM marketplace_outreach_requests WHERE client_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 500`,
            [req.client.id]
        )).rows;
        res.json({ requests: rows.map(publicRow) });
    } catch (error) {
        next(error);
    }
};

// ─── Admin / Manager ─────────────────────────────────────────────────

/** @route GET /api/admin|manager/marketplace/outreach?status&search&page&limit */
const listRequests = async (req, res, next) => {
    try {
        await ensureSchema();
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        const params = [];
        const where = [];
        const status = String(req.query.status || '');
        if (STATUSES.includes(status)) { params.push(status); where.push(`r.status = $${params.length}`); }
        const search = String(req.query.search || '').trim();
        if (search) {
            params.push(`%${search.replace(/^https?:\/\//i, '').replace(/^www\./i, '')}%`);
            where.push(`(r.domain ILIKE $${params.length} OR u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
        }
        const from = `FROM marketplace_outreach_requests r
                      LEFT JOIN users u ON u.id = r.client_user_id
                      LEFT JOIN users s ON s.id = r.updated_by
                      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
        const total = parseInt((await query(`SELECT COUNT(*) AS c ${from}`, params)).rows[0].c);
        const rows = (await query(
            `SELECT r.*, u.name AS client_name, u.email AS client_email, s.name AS updated_by_name
             ${from}
             ORDER BY (r.status = 'requested') DESC, r.created_at DESC, r.id DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, (page - 1) * limit]
        )).rows;
        const counts = Object.fromEntries((await query(
            `SELECT status, COUNT(*)::int AS c FROM marketplace_outreach_requests GROUP BY status`
        )).rows.map(r => [r.status, r.c]));
        res.json({
            requests: rows.map(r => ({ ...publicRow(r), marketplace: r.marketplace, client_id: r.client_user_id, client_name: r.client_name, client_email: r.client_email, updated_by_name: r.updated_by_name })),
            counts: Object.fromEntries(STATUSES.map(s => [s, counts[s] || 0])),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        });
    } catch (error) {
        next(error);
    }
};

/** @route PUT /api/admin|manager/marketplace/outreach/:id  { status } */
const updateStatus = async (req, res, next) => {
    try {
        await ensureSchema();
        const status = String(req.body.status || '');
        if (!STATUSES.includes(status)) return bad(res, 'Unknown status');
        const row = (await query(
            `UPDATE marketplace_outreach_requests SET status = $1, updated_by = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
            [status, req.user.id, req.params.id]
        )).rows[0];
        if (!row) return bad(res, 'Request not found', 404);
        res.json({ message: 'Status updated', request: publicRow(row) });
    } catch (error) {
        next(error);
    }
};

module.exports = { createRequest, createBulk, myRequests, listRequests, updateStatus, cleanDomain, STATUSES };
