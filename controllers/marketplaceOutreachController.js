/**
 * Marketplace outreach requests
 * A Pro client searches for a domain we don't have → asks us to reach out to it, with a budget.
 *
 * Flow: requested (client) → assigned (manager picks an outreach member) → submitted (outreach member enters the
 * site's details) → manager reviews: approve = site added to Sites (approved, on the marketplace) + client notified,
 * send back (with a note) → sent_back → submitted again …, or not_possible.
 * Client: create + see own requests (read-only, simple statuses). Outreach member: only tasks assigned to them.
 * Admin / Manager: everything, can edit the details.
 */

const crypto = require('crypto');
const { query, transaction } = require('../config/database');
const plans = require('../utils/marketplacePlan');

const STATUSES = ['requested', 'assigned', 'submitted', 'sent_back', 'added', 'not_possible'];
const OPEN = ['requested', 'in_progress', 'assigned', 'submitted', 'sent_back'];
const MAX_OPEN_PER_CLIENT = 50;
const MAX_BUDGET = 100000;
/** What the client sees – the team's inner steps all read "In progress" */
const clientStatus = (s) => (['assigned', 'submitted', 'sent_back', 'in_progress'].includes(s) ? 'in_progress' : s);

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
    // Outreach team workflow
    for (const col of [
        'assigned_to INT', 'assigned_by INT', 'assigned_at TIMESTAMPTZ',
        `details JSONB NOT NULL DEFAULT '{}'`, 'submitted_at TIMESTAMPTZ',
        'review_note TEXT', 'reviewed_by INT', 'reviewed_at TIMESTAMPTZ', 'site_id INT'
    ]) await query(`ALTER TABLE marketplace_outreach_requests ADD COLUMN IF NOT EXISTS ${col}`);
    await query(`CREATE INDEX IF NOT EXISTS mp_outreach_assignee_idx ON marketplace_outreach_requests (assigned_to, status)`);
    // first version had a plain "in progress" status – it is "assigned" now (without a member until one is picked)
    await query(`UPDATE marketplace_outreach_requests SET status = 'assigned' WHERE status = 'in_progress'`);
})().catch(err => { ready = null; throw err; }));

/** "https://www.Example.com/blog?x" → "example.com"; null when it isn't a domain */
const cleanDomain = (raw) => {
    const d = String(raw || '').trim().toLowerCase()
        .replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
    return /^(?=.{4,253}$)([a-z0-9](-*[a-z0-9])*)(\.[a-z0-9](-*[a-z0-9])*)+$/.test(d) && /\.[a-z]{2,}$/.test(d) ? d : null;
};

const bad = (res, message, code = 400) => res.status(code).json({ error: 'Validation Error', message });

/** A row as the client sees it (simple status, none of the team's details) */
const publicRow = (r) => ({
    id: r.id, domain: r.domain, budget: Number(r.budget), note: r.note || '', status: clientStatus(r.status),
    created_at: r.created_at, updated_at: r.updated_at
});

// ─── Site details entered by the outreach team ───────────────────────

const num = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v));
const text = (v, max = 255) => String(v ?? '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Clean the details form; `full` = every required field must be there (submit / approve) → { details } or { error } */
const cleanDetails = (raw = {}, full = false) => {
    const d = {
        blogger_email: text(raw.blogger_email).toLowerCase(),
        gp_price: num(raw.gp_price),
        ne_price: num(raw.ne_price),
        website_niche: text(raw.website_niche, 500),
        category: text(raw.category, 100),
        fc_accepted: raw.fc_accepted === true || raw.fc_accepted === 'true' || raw.fc_accepted === 1,
        fc_gp: num(raw.fc_gp),
        fc_ne: num(raw.fc_ne),
        da: num(raw.da), dr: num(raw.dr), traffic: num(raw.traffic),
        country: text(raw.country, 100),
        sample_url: text(raw.sample_url, 500),
        note: text(raw.note, 1000)
    };
    if (!d.fc_accepted) { d.fc_gp = null; d.fc_ne = null; }
    const err = (m) => ({ error: m });
    if (d.blogger_email && !EMAIL_RE.test(d.blogger_email)) return err('Please enter a valid blogger email');
    for (const [k, label] of [['gp_price', 'GP price'], ['ne_price', 'NE price'], ['fc_gp', 'FC GP price'], ['fc_ne', 'FC NE price'], ['traffic', 'Traffic']]) {
        if (d[k] !== null && (d[k] < 0 || d[k] > 1e9)) return err(`${label} must be a positive number`);
    }
    for (const [k, label] of [['da', 'DA'], ['dr', 'DR']]) {
        if (d[k] !== null && (d[k] < 0 || d[k] > 100)) return err(`${label} must be between 0 and 100`);
    }
    if (d.sample_url && !/^https?:\/\/\S+\.\S+/i.test(d.sample_url)) return err('Sample post must be a full URL (https://…)');
    if (full) {
        if (!d.blogger_email) return err('Blogger email is required');
        if (!(d.gp_price > 0) && !(d.ne_price > 0)) return err('Enter the GP price (or at least the NE price)');
        if (!d.website_niche) return err('Website niche is required');
        if (!d.category) return err('Main category is required');
        if (d.fc_accepted && !(d.fc_gp > 0) && !(d.fc_ne > 0)) return err('FC is ticked – enter the FC GP or FC NE price');
    }
    return { details: d };
};

// ─── Notifications (same table the marketplace and dashboards read) ──

const notify = (userId, type, data) => (userId ? query(
    `INSERT INTO notifications (id, type, notifiable_type, notifiable_id, data, created_at, updated_at)
     VALUES ($1, $2, 'App\\Models\\User', $3, $4, NOW(), NOW())`,
    [crypto.randomUUID(), type, userId, JSON.stringify(data)]
).catch(err => console.error('[Outreach] notification failed:', err.message)) : Promise.resolve());

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

const STAFF_SELECT = `
    SELECT r.*, u.name AS client_name, u.email AS client_email,
           a.name AS assigned_to_name, a.email AS assigned_to_email, s.name AS updated_by_name, rv.name AS reviewed_by_name
    FROM marketplace_outreach_requests r
    LEFT JOIN users u ON u.id = r.client_user_id
    LEFT JOIN users a ON a.id = r.assigned_to
    LEFT JOIN users s ON s.id = r.updated_by
    LEFT JOIN users rv ON rv.id = r.reviewed_by`;

/** Everything staff see about a request (client info only for admin / manager – see `client` flag) */
const staffRow = (r, client = true) => ({
    id: r.id, domain: r.domain, budget: Number(r.budget), note: r.note || '', status: r.status, marketplace: r.marketplace,
    created_at: r.created_at, updated_at: r.updated_at,
    ...(client ? { client_id: r.client_user_id, client_name: r.client_name, client_email: r.client_email } : {}),
    assigned_to: r.assigned_to, assigned_to_name: r.assigned_to_name || null, assigned_at: r.assigned_at,
    details: r.details || {}, submitted_at: r.submitted_at,
    review_note: r.review_note || '', reviewed_by_name: r.reviewed_by_name || null, reviewed_at: r.reviewed_at,
    site_id: r.site_id, updated_by_name: r.updated_by_name || null
});

const getRow = async (id) => (await query(`${STAFF_SELECT} WHERE r.id = $1`, [id])).rows[0];

/** @route GET /api/admin|manager/marketplace/outreach?status&search&assigned_to&page&limit */
const listRequests = async (req, res, next) => {
    try {
        await ensureSchema();
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        const params = [];
        const where = [];
        const status = String(req.query.status || '');
        if (STATUSES.includes(status)) { params.push(status); where.push(`r.status = $${params.length}`); }
        if (req.query.assigned_to) { params.push(parseInt(req.query.assigned_to) || 0); where.push(`r.assigned_to = $${params.length}`); }
        const search = String(req.query.search || '').trim();
        if (search) {
            params.push(`%${search.replace(/^https?:\/\//i, '').replace(/^www\./i, '')}%`);
            where.push(`(r.domain ILIKE $${params.length} OR u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
        }
        const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
        const total = parseInt((await query(`SELECT COUNT(*) AS c FROM (${STAFF_SELECT}${whereSql}) x`, params)).rows[0].c);
        const rows = (await query(
            `${STAFF_SELECT}${whereSql}
             ORDER BY CASE r.status WHEN 'submitted' THEN 0 WHEN 'requested' THEN 1 WHEN 'sent_back' THEN 2 WHEN 'assigned' THEN 3 ELSE 4 END,
                      r.created_at DESC, r.id DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, (page - 1) * limit]
        )).rows;
        const counts = Object.fromEntries((await query(
            `SELECT status, COUNT(*)::int AS c FROM marketplace_outreach_requests GROUP BY status`
        )).rows.map(r => [r.status, r.c]));
        res.json({
            requests: rows.map(r => staffRow(r)),
            counts: Object.fromEntries(STATUSES.map(s => [s, counts[s] || 0])),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        });
    } catch (error) {
        next(error);
    }
};

/** @route GET /api/admin|manager/marketplace/outreach/members – active Outreach Team members (assign dropdown) */
const listMembers = async (req, res, next) => {
    try {
        await ensureSchema();
        const rows = (await query(
            `SELECT u.id, u.name, u.email,
                    (SELECT COUNT(*) FROM marketplace_outreach_requests r WHERE r.assigned_to = u.id AND r.status IN ('assigned', 'sent_back'))::int AS open_tasks
             FROM users u WHERE LOWER(u.role) = 'outreach' AND u.status = 1 ORDER BY u.name`
        )).rows;
        res.json({ members: rows });
    } catch (error) {
        next(error);
    }
};

/** @route PUT /api/admin|manager/marketplace/outreach/:id/assign  { user_id } – give the task to an outreach member */
const assignRequest = async (req, res, next) => {
    try {
        await ensureSchema();
        const member = (await query(`SELECT id, name FROM users WHERE id = $1 AND LOWER(role) = 'outreach' AND status = 1`, [parseInt(req.body.user_id) || 0])).rows[0];
        if (!member) return bad(res, 'Pick an active Outreach Team member');
        const r = await getRow(req.params.id);
        if (!r) return bad(res, 'Request not found', 404);
        if (['added', 'not_possible'].includes(r.status)) return bad(res, 'This request is closed');
        await query(
            `UPDATE marketplace_outreach_requests
             SET assigned_to = $1, assigned_by = $2, assigned_at = NOW(), updated_by = $2, updated_at = NOW(),
                 status = CASE WHEN status IN ('requested', 'in_progress') THEN 'assigned' ELSE status END
             WHERE id = $3`,
            [member.id, req.user.id, r.id]
        );
        if (Number(r.assigned_to) !== Number(member.id)) {
            notify(member.id, 'outreach_assigned', { title: 'New outreach task', message: `Get ${r.domain} – client budget $${Number(r.budget).toFixed(2)}`, request_id: r.id, domain: r.domain });
        }
        res.json({ message: `Assigned to ${member.name}`, request: staffRow(await getRow(r.id)) });
    } catch (error) {
        next(error);
    }
};

/** @route PUT /api/admin|manager/marketplace/outreach/:id/details  { details } – staff edit what the outreach member entered */
const saveDetailsStaff = async (req, res, next) => {
    try {
        await ensureSchema();
        const { details, error } = cleanDetails(req.body.details);
        if (error) return bad(res, error);
        const r = (await query(
            `UPDATE marketplace_outreach_requests SET details = $1, updated_by = $2, updated_at = NOW() WHERE id = $3 RETURNING id`,
            [JSON.stringify(details), req.user.id, req.params.id]
        )).rows[0];
        if (!r) return bad(res, 'Request not found', 404);
        res.json({ message: 'Details saved', request: staffRow(await getRow(r.id)) });
    } catch (error) {
        next(error);
    }
};

const keySql = `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(root_domain), '^https?://', ''), '^www\\.', ''))`;

/**
 * @route POST /api/admin|manager/marketplace/outreach/:id/approve  { details? }
 * Adds the site to Sites – approved and active, so it is on the marketplace – (or updates the same domain if it's
 * already there), closes the request as "added" and tells the client.
 */
const approveRequest = async (req, res, next) => {
    try {
        await ensureSchema();
        const r = await getRow(req.params.id);
        if (!r) return bad(res, 'Request not found', 404);
        if (['added', 'not_possible'].includes(r.status)) return bad(res, 'This request is already closed');
        const { details: d, error } = cleanDetails({ ...(r.details || {}), ...(req.body.details || {}) }, true);
        if (error) return bad(res, error);

        // The blogger: an existing blogger account with that email owns the site; otherwise the email is kept and an
        // account can be made later (Sites → Create Account From Sites), same as the Excel upload
        const blogger = (await query(
            `SELECT id, status FROM users WHERE LOWER(TRIM(email)) = $1 AND LOWER(role) IN ('vendor', 'blogger') ORDER BY status DESC, id LIMIT 1`,
            [d.blogger_email]
        )).rows[0];
        if (blogger && Number(blogger.status) !== 1) return bad(res, `The blogger account ${d.blogger_email} is inactive – activate it first, or use another email`);

        const price = (n) => (n > 0 ? String(n) : '');
        const values = {
            root_domain: r.domain, email: d.blogger_email, uploaded_user_id: blogger ? blogger.id : 1,
            niche: d.website_niche.slice(0, 255), category: d.category, website_niche: d.website_niche,
            gp_price: price(d.gp_price), niche_edit_price: price(d.ne_price),
            fc_gp: d.fc_gp > 0 ? d.fc_gp : null, fc_ne: d.fc_ne > 0 ? d.fc_ne : null,
            da: d.da, dr: d.dr, traffic: d.traffic, traffic_source: d.traffic !== null ? String(Math.round(d.traffic)) : '',
            country_source: d.country, sample_url: d.sample_url
        };

        const siteId = await transaction(async (client) => {
            const existing = (await client.query(
                `SELECT id FROM new_sites WHERE ${keySql} = $1 AND (delete_site IS NULL OR delete_site = 0)
                 ORDER BY (site_status = '1') DESC, id DESC LIMIT 1`, [r.domain]
            )).rows[0];
            let id;
            if (existing) {
                id = existing.id;
                await client.query(
                    `UPDATE new_sites SET email = $1, uploaded_user_id = $2, niche = $3, category = $4, website_niche = $5,
                            gp_price = $6, niche_edit_price = $7, fc_gp = $8, fc_ne = $9,
                            da = COALESCE($10, da), dr = COALESCE($11, dr), traffic = COALESCE($12, traffic),
                            traffic_source = COALESCE(NULLIF($13, ''), traffic_source), country_source = COALESCE(NULLIF($14, ''), country_source),
                            sample_url = COALESCE(NULLIF($15, ''), sample_url), site_status = '1', updated_at = NOW()
                     WHERE id = $16`,
                    [values.email, values.uploaded_user_id, values.niche, values.category, values.website_niche,
                        values.gp_price, values.niche_edit_price, values.fc_gp, values.fc_ne,
                        values.da, values.dr, values.traffic, values.traffic_source, values.country_source, values.sample_url, id]
                );
            } else {
                id = (await client.query(
                    `INSERT INTO new_sites (root_domain, email, uploaded_user_id, niche, category, website_niche,
                            gp_price, niche_edit_price, fc_gp, fc_ne, da, dr, traffic, traffic_source, country_source, sample_url,
                            site_status, source, created_at, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'1','outreach',NOW(),NOW()) RETURNING id`,
                    [values.root_domain, values.email, values.uploaded_user_id, values.niche, values.category, values.website_niche,
                        values.gp_price, values.niche_edit_price, values.fc_gp, values.fc_ne,
                        values.da, values.dr, values.traffic, values.traffic_source, values.country_source, values.sample_url]
                )).rows[0].id;
            }
            await client.query(
                `UPDATE marketplace_outreach_requests
                 SET status = 'added', details = $1, site_id = $2, reviewed_by = $3, reviewed_at = NOW(), review_note = NULL,
                     updated_by = $3, updated_at = NOW()
                 WHERE id = $4`,
                [JSON.stringify(d), id, req.user.id, r.id]
            );
            return id;
        });

        // Tell the client (marketplace notification + email) and the outreach member
        notifyClientAdded(r).catch(() => {});
        notify(r.assigned_to, 'outreach_approved', { title: 'Site approved', message: `${r.domain} was approved and added to the marketplace`, request_id: r.id, domain: r.domain });
        res.json({
            message: `${r.domain} added to Sites and the marketplace${blogger ? '' : ' – no blogger account for this email yet (create one in Sites → Create Account From Sites)'}`,
            site_id: siteId, blogger_account: !!blogger, request: staffRow(await getRow(r.id))
        });
    } catch (error) {
        next(error);
    }
};

/** Client: "the site you asked for is on the marketplace" (in-marketplace notification + email in the marketplace's brand) */
const notifyClientAdded = async (r) => {
    const { getBrand } = require('../utils/marketplace');
    const { sendEmail } = require('../utils/emailService');
    const client = (await query(`SELECT id, name, email, marketplace FROM users WHERE id = $1 AND role = 'client'`, [r.client_user_id])).rows[0];
    if (!client) return;
    await notify(client.id, 'outreach_added', {
        title: 'Your requested site is available',
        message: `${r.domain} is now on the marketplace – you can order it.`,
        site: r.domain, request_id: r.id
    });
    const brand = getBrand(client.marketplace || r.marketplace);
    const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await sendEmail(client.email, `✅ ${r.domain} is now available – ${brand.name}`, `
        <h2>Good news${client.name ? `, ${esc(client.name)}` : ''}!</h2>
        <p>You asked us to get <strong>${esc(r.domain)}</strong>. Our outreach team did – it's now on the marketplace and you can order it.</p>
        <p style="text-align:center;margin:24px 0;"><a href="${brand.url}/" class="btn">Find ${esc(r.domain)} →</a></p>`, { brand }
    ).catch(err => console.error('[Outreach] client email failed:', err.message));
};

/** @route POST /api/admin|manager/marketplace/outreach/:id/send-back  { note } – back to the outreach member to fix */
const sendBack = async (req, res, next) => {
    try {
        await ensureSchema();
        const note = text(req.body.note, 1000);
        if (!note) return bad(res, 'Please write what needs to change');
        const r = await getRow(req.params.id);
        if (!r) return bad(res, 'Request not found', 404);
        if (!r.assigned_to) return bad(res, 'Assign the request to an outreach member first');
        if (['added', 'not_possible'].includes(r.status)) return bad(res, 'This request is closed');
        await query(
            `UPDATE marketplace_outreach_requests SET status = 'sent_back', review_note = $1, reviewed_by = $2, reviewed_at = NOW(),
                    updated_by = $2, updated_at = NOW() WHERE id = $3`,
            [note, req.user.id, r.id]
        );
        notify(r.assigned_to, 'outreach_sent_back', { title: 'Task sent back', message: `${r.domain}: ${note}`, request_id: r.id, domain: r.domain });
        res.json({ message: 'Sent back to the outreach member', request: staffRow(await getRow(r.id)) });
    } catch (error) {
        next(error);
    }
};

/** @route PUT /api/admin|manager/marketplace/outreach/:id  { status: 'not_possible' | 'requested' } – close, or reopen */
const updateStatus = async (req, res, next) => {
    try {
        await ensureSchema();
        const status = String(req.body.status || '');
        if (!['not_possible', 'requested'].includes(status)) return bad(res, 'Use Assign / Approve / Send back for the other steps');
        const r = await getRow(req.params.id);
        if (!r) return bad(res, 'Request not found', 404);
        if (r.status === 'added') return bad(res, 'This site was already added');
        await query(
            `UPDATE marketplace_outreach_requests
             SET status = $1, updated_by = $2, updated_at = NOW(),
                 assigned_to = CASE WHEN $1 = 'requested' THEN NULL ELSE assigned_to END
             WHERE id = $3`,
            [status, req.user.id, r.id]
        );
        if (status === 'not_possible') {
            notify(r.client_user_id, 'outreach_not_possible', { title: 'Outreach update', message: `We couldn't get ${r.domain} this time.`, site: r.domain, request_id: r.id });
            notify(r.assigned_to, 'outreach_closed', { title: 'Task closed', message: `${r.domain} was marked "Not possible"`, request_id: r.id, domain: r.domain });
        }
        res.json({ message: status === 'not_possible' ? 'Marked as not possible' : 'Reopened', request: staffRow(await getRow(r.id)) });
    } catch (error) {
        next(error);
    }
};

// ─── Outreach Team member (their own tasks only) ─────────────────────

const myTask = async (req) => {
    const r = await getRow(req.params.id);
    // ids can come back as text (BIGINT) or number – compare as numbers
    return r && Number(r.assigned_to) === Number(req.user.id) ? r : null;
};

/** @route GET /api/outreach/dashboard */
const memberDashboard = async (req, res, next) => {
    try {
        await ensureSchema();
        const counts = Object.fromEntries((await query(
            `SELECT status, COUNT(*)::int AS c FROM marketplace_outreach_requests WHERE assigned_to = $1 GROUP BY status`, [req.user.id]
        )).rows.map(r => [r.status, r.c]));
        const todo = (await query(
            `${STAFF_SELECT} WHERE r.assigned_to = $1 AND r.status IN ('assigned', 'sent_back') ORDER BY (r.status = 'sent_back') DESC, r.assigned_at DESC LIMIT 8`, [req.user.id]
        )).rows.map(r => staffRow(r, false));
        const unread = Number((await query(
            `SELECT COUNT(*) AS c FROM notifications WHERE notifiable_id = $1 AND read_at IS NULL AND type LIKE 'outreach_%'`, [req.user.id]
        )).rows[0].c);
        res.json({
            counts: { todo: (counts.assigned || 0) + (counts.sent_back || 0), sent_back: counts.sent_back || 0, submitted: counts.submitted || 0, added: counts.added || 0, not_possible: counts.not_possible || 0 },
            todo, unread
        });
    } catch (error) {
        next(error);
    }
};

/** @route GET /api/outreach/tasks?status=todo|sent_back|submitted|added|not_possible */
const memberTasks = async (req, res, next) => {
    try {
        await ensureSchema();
        const st = String(req.query.status || 'todo');
        const map = { todo: ['assigned', 'sent_back'], sent_back: ['sent_back'], submitted: ['submitted'], added: ['added'], not_possible: ['not_possible'], all: STATUSES };
        const rows = (await query(
            `${STAFF_SELECT} WHERE r.assigned_to = $1 AND r.status = ANY($2) ORDER BY (r.status = 'sent_back') DESC, r.assigned_at DESC, r.id DESC LIMIT 300`,
            [req.user.id, map[st] || map.todo]
        )).rows;
        res.json({ tasks: rows.map(r => staffRow(r, false)) });
    } catch (error) {
        next(error);
    }
};

/** @route PUT /api/outreach/tasks/:id  { details } – save progress (no checks for missing fields) */
const memberSave = async (req, res, next) => {
    try {
        await ensureSchema();
        const r = await myTask(req);
        if (!r) return bad(res, 'Task not found', 404);
        if (!['assigned', 'sent_back'].includes(r.status)) return bad(res, 'This task is no longer open for changes');
        const { details, error } = cleanDetails(req.body.details);
        if (error) return bad(res, error);
        await query(`UPDATE marketplace_outreach_requests SET details = $1, updated_at = NOW() WHERE id = $2`, [JSON.stringify(details), r.id]);
        res.json({ message: 'Saved', task: staffRow(await getRow(r.id), false) });
    } catch (error) {
        next(error);
    }
};

/** @route POST /api/outreach/tasks/:id/submit  { details } – send to the manager for review */
const memberSubmit = async (req, res, next) => {
    try {
        await ensureSchema();
        const r = await myTask(req);
        if (!r) return bad(res, 'Task not found', 404);
        if (!['assigned', 'sent_back'].includes(r.status)) return bad(res, 'This task was already submitted');
        const { details, error } = cleanDetails(req.body.details, true);
        if (error) return bad(res, error);
        await query(
            `UPDATE marketplace_outreach_requests SET details = $1, status = 'submitted', submitted_at = NOW(), updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(details), r.id]
        );
        res.json({ message: 'Sent to the manager for review', task: staffRow(await getRow(r.id), false) });
    } catch (error) {
        next(error);
    }
};

/** @route GET /api/outreach/notifications  ·  POST /api/outreach/notifications/read { id? } */
const memberNotifications = async (req, res, next) => {
    try {
        const rows = (await query(
            `SELECT id, type, data, read_at, created_at FROM notifications
             WHERE notifiable_id = $1 AND type LIKE 'outreach_%' ORDER BY created_at DESC LIMIT 100`, [req.user.id]
        )).rows;
        res.json({ notifications: rows.map(n => ({ ...n, data: typeof n.data === 'string' ? JSON.parse(n.data) : n.data })), unread: rows.filter(n => !n.read_at).length });
    } catch (error) {
        next(error);
    }
};
const memberReadNotifications = async (req, res, next) => {
    try {
        const params = [req.user.id];
        let extra = '';
        if (req.body?.id) { params.push(String(req.body.id)); extra = ` AND id = $2`; }
        await query(`UPDATE notifications SET read_at = NOW() WHERE notifiable_id = $1 AND read_at IS NULL AND type LIKE 'outreach_%'${extra}`, params);
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    createRequest, createBulk, myRequests,
    listRequests, listMembers, assignRequest, saveDetailsStaff, approveRequest, sendBack, updateStatus,
    memberDashboard, memberTasks, memberSave, memberSubmit, memberNotifications, memberReadNotifications,
    cleanDomain, STATUSES
};
