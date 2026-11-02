/**
 * Marketplace support chat
 *   Client side:  /api/marketplace/:marketplace/support...   (requireClient → req.client)
 *   Staff side:   /api/support/...                           (managers + admins, shared inbox)
 */

const { query } = require('../config/database');
const chat = require('../utils/supportChat');
const plans = require('../utils/marketplacePlan');

const bad = (res, message, code = 400) => res.status(code).json({ error: 'Validation Error', message });
const ioOf = (req) => req.app.get('io');
const publicBase = (req) => {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
    return (process.env.PUBLIC_API_URL || `${proto}://${req.get('host')}`).replace(/\/+$/, '').replace(/\/api$/, '');
};

/** @route POST .../support/upload (multipart "file") → { url, name, type, size } */
const uploadFile = (req, res) => {
    if (!req.file) return bad(res, 'Please choose an image, PDF or DOC file');
    res.status(201).json({
        url: `${publicBase(req)}/uploads/support-files/${req.file.filename}`,
        name: req.file.originalname.slice(0, 200), type: req.file.mimetype, size: req.file.size
    });
};

// ─── Client ───────────────────────────────────────────────────────────

/** @route GET /api/marketplace/:marketplace/support?before= – the client's conversation */
const clientConversation = async (req, res, next) => {
    try {
        const conv = await chat.conversationFor(req.params.marketplace, req.client.id);
        const messages = await chat.messageRows(conv.id, { before: parseInt(req.query.before) || null });
        res.json({ conversation: { id: conv.id, unread: conv.client_unread }, messages: messages.map(chat.forClient) });
    } catch (error) {
        next(error);
    }
};

/** @route POST /api/marketplace/:marketplace/support/messages  { body, attachments?, order_id? } */
const clientSend = async (req, res, next) => {
    try {
        const conv = await chat.conversationFor(req.params.marketplace, req.client.id);
        let orderId = parseInt(req.body.order_id) || null;
        if (orderId) {
            const own = (await query(`SELECT id FROM marketplace_orders WHERE id = $1 AND client_user_id = $2`, [orderId, req.client.id])).rows[0];
            if (!own) orderId = null;
        }
        const msg = await chat.postMessage({ io: ioOf(req), conversation: conv, sender: { type: 'client', userId: req.client.id }, body: req.body.body, attachments: req.body.attachments, orderId });
        await chat.markRead(conv.id, 'client');
        res.status(201).json({ message: chat.forClient({ ...msg, sender_type: 'client' }) });
    } catch (error) {
        if (error.statusCode === 400) return bad(res, error.message);
        next(error);
    }
};

/** @route POST /api/marketplace/:marketplace/support/read */
const clientRead = async (req, res, next) => {
    try {
        const conv = await chat.conversationFor(req.params.marketplace, req.client.id);
        await chat.markRead(conv.id, 'client');
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
};

/** @route GET /api/marketplace/:marketplace/support/unread */
const clientUnread = async (req, res, next) => {
    try {
        await chat.ensureSchema();
        const r = (await query(`SELECT client_unread FROM marketplace_conversations WHERE marketplace = $1 AND client_user_id = $2`, [req.params.marketplace, req.client.id])).rows[0];
        res.json({ unread: r?.client_unread || 0 });
    } catch (error) {
        next(error);
    }
};

// ─── Staff (shared inbox) ─────────────────────────────────────────────

const mainManagerSql = `(SELECT m.name FROM client_orders co JOIN users m ON m.id = co.assigned_to
                         WHERE co.client_user_id = c.client_user_id ORDER BY co.created_at DESC LIMIT 1)`;

/** @route GET /api/support/conversations?search&filter=unread */
const staffList = async (req, res, next) => {
    try {
        await chat.ensureSchema();
        const params = [];
        const where = ['c.last_message_at IS NOT NULL'];
        if (String(req.query.search || '').trim()) {
            params.push(`%${String(req.query.search).trim()}%`);
            where.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
        }
        if (req.query.filter === 'unread') where.push('c.staff_unread > 0');
        const rows = (await query(
            `SELECT c.id, c.client_user_id, c.marketplace, c.last_message_at, c.last_message_preview, c.last_sender, c.staff_unread,
                    u.name AS client_name, u.email AS client_email, ${mainManagerSql} AS main_manager
             FROM marketplace_conversations c JOIN users u ON u.id = c.client_user_id
             WHERE ${where.join(' AND ')}
             ORDER BY (c.staff_unread > 0) DESC, c.last_message_at DESC
             LIMIT 200`, params
        )).rows;
        res.json({ conversations: rows });
    } catch (error) {
        next(error);
    }
};

/** Client details shown next to the chat */
const clientInfo = async (clientId) => {
    const u = (await query(`SELECT id, name, email, marketplace, created_at, last_login FROM users WHERE id = $1`, [clientId])).rows[0];
    if (!u) return null;
    const w = (await query(`SELECT COALESCE(balance, 0)::float AS balance FROM wallets WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [clientId])).rows[0];
    const orders = (await query(
        `SELECT mo.id, mo.order_number, mo.total_price::float AS total_price, mo.created_at,
                (SELECT co.id FROM client_orders co WHERE co.marketplace_order_id = mo.id ORDER BY co.id LIMIT 1) AS client_order_id,
                (SELECT STRING_AGG(DISTINCT co.status, ', ') FROM client_orders co WHERE co.marketplace_order_id = mo.id) AS statuses
         FROM marketplace_orders mo WHERE mo.client_user_id = $1 ORDER BY mo.created_at DESC LIMIT 5`, [clientId]
    )).rows;
    const totals = (await query(`SELECT COUNT(*)::int AS orders, COALESCE(SUM(total_price), 0)::float AS spent FROM marketplace_orders WHERE client_user_id = $1`, [clientId])).rows[0];
    const plan = await plans.getPlan(clientId).catch(() => null);
    return { ...u, balance: w?.balance || 0, plan, orders, totals };
};

/** @route GET /api/support/conversations/:id?before= */
const staffConversation = async (req, res, next) => {
    try {
        await chat.ensureSchema();
        const conv = (await query(`SELECT * FROM marketplace_conversations WHERE id = $1`, [req.params.id])).rows[0];
        if (!conv) return bad(res, 'Conversation not found', 404);
        const messages = await chat.messageRows(conv.id, { before: parseInt(req.query.before) || null });
        res.json({ conversation: conv, client: await clientInfo(conv.client_user_id), messages: messages.map(chat.forStaff) });
    } catch (error) {
        next(error);
    }
};

/** @route POST /api/support/conversations/:id/messages  { body, attachments?, order_id? } */
const staffSend = async (req, res, next) => {
    try {
        await chat.ensureSchema();
        const conv = (await query(`SELECT * FROM marketplace_conversations WHERE id = $1`, [req.params.id])).rows[0];
        if (!conv) return bad(res, 'Conversation not found', 404);
        const msg = await chat.postMessage({ io: ioOf(req), conversation: conv, sender: { type: 'staff', userId: req.user.id }, body: req.body.body, attachments: req.body.attachments, orderId: parseInt(req.body.order_id) || null });
        await chat.markRead(conv.id, 'staff');
        res.status(201).json({ message: msg });
    } catch (error) {
        if (error.statusCode === 400) return bad(res, error.message);
        next(error);
    }
};

/** @route POST /api/support/start  { client_user_id, body, order_id? } – manager messages a client first */
const staffStart = async (req, res, next) => {
    try {
        const u = (await query(`SELECT id, marketplace FROM users WHERE id = $1 AND role = 'client' AND marketplace IS NOT NULL`, [req.body.client_user_id])).rows[0];
        if (!u) return bad(res, 'This client is not a marketplace client', 404);
        const conv = await chat.conversationFor(u.marketplace, u.id);
        let msg = null;
        if (String(req.body.body || '').trim() || (req.body.attachments || []).length) {
            msg = await chat.postMessage({ io: ioOf(req), conversation: conv, sender: { type: 'staff', userId: req.user.id }, body: req.body.body, attachments: req.body.attachments, orderId: parseInt(req.body.order_id) || null });
        }
        res.status(201).json({ conversation_id: conv.id, message: msg });
    } catch (error) {
        if (error.statusCode === 400) return bad(res, error.message);
        next(error);
    }
};

/** @route POST /api/support/conversations/:id/read */
const staffRead = async (req, res, next) => {
    try {
        await chat.markRead(parseInt(req.params.id), 'staff');
        ioOf(req)?.to('support_staff').emit('support:read', { conversation_id: parseInt(req.params.id) });
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
};

/** @route GET /api/support/unread – conversations waiting for a staff reply */
const staffUnread = async (req, res, next) => {
    try {
        await chat.ensureSchema();
        const r = (await query(`SELECT COUNT(*)::int AS c FROM marketplace_conversations WHERE staff_unread > 0`)).rows[0];
        res.json({ unread: r.c });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    uploadFile, clientConversation, clientSend, clientRead, clientUnread,
    staffList, staffConversation, staffSend, staffStart, staffRead, staffUnread
};
