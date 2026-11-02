/**
 * Marketplace support chat: one conversation per client, answered by all managers (shared inbox).
 *
 * - Clients see replies from "Support Team" (staff names are never sent to the client).
 * - Live updates over socket.io, but only after 'support:join' with a valid login token:
 *     client  → room support_client_<clientId>
 *     manager/admin → room support_staff
 * - Unread counters on both sides; one email to the client per burst of staff replies
 *   (sent when the client isn't online, and only again after the client has read the chat).
 */

const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { sendEmail } = require('./emailService');
const mp = require('./marketplace');

const STAFF_ROLES = ['manager', 'admin', 'super_admin'];
const MAX_BODY = 4000;
const MAX_FILES = 5;

let schemaReady = null;
const ensureSchema = () => (schemaReady = schemaReady || (async () => {
    await query(`
        CREATE TABLE IF NOT EXISTS marketplace_conversations (
            id SERIAL PRIMARY KEY,
            marketplace VARCHAR(30) NOT NULL,
            client_user_id INT NOT NULL,
            last_message_at TIMESTAMPTZ,
            last_message_preview TEXT,
            last_sender VARCHAR(10),
            client_unread INT NOT NULL DEFAULT 0,   -- staff messages the client hasn't read
            staff_unread INT NOT NULL DEFAULT 0,    -- client messages no staff member has read
            client_emailed BOOLEAN NOT NULL DEFAULT false, -- an email was sent for the current unread burst
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (marketplace, client_user_id)
        )`);
    await query(`
        CREATE TABLE IF NOT EXISTS marketplace_messages (
            id SERIAL PRIMARY KEY,
            conversation_id INT NOT NULL REFERENCES marketplace_conversations(id) ON DELETE CASCADE,
            sender_type VARCHAR(10) NOT NULL,       -- client | staff
            sender_user_id INT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            attachments JSONB NOT NULL DEFAULT '[]',
            order_id INT,                            -- marketplace_orders.id when asked about an order
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await query(`CREATE INDEX IF NOT EXISTS marketplace_messages_conv_idx ON marketplace_messages (conversation_id, id)`);
})().catch(err => { schemaReady = null; throw err; }));

/** Find or create the client's conversation */
const conversationFor = async (marketplace, clientId) => {
    await ensureSchema();
    await query(
        `INSERT INTO marketplace_conversations (marketplace, client_user_id) VALUES ($1,$2) ON CONFLICT (marketplace, client_user_id) DO NOTHING`,
        [marketplace, clientId]
    );
    return (await query(`SELECT * FROM marketplace_conversations WHERE marketplace = $1 AND client_user_id = $2`, [marketplace, clientId])).rows[0];
};

/** Clean the attachment list sent by the browser: only files we uploaded ourselves */
const cleanAttachments = (list) => (Array.isArray(list) ? list : []).slice(0, MAX_FILES)
    .filter(a => a && /^https?:\/\/[^/\s]+\/uploads\/support-files\/sc-[\w-]+\.(png|jpe?g|gif|webp|pdf|docx?)$/i.test(String(a.url || '')))
    .map(a => ({ url: String(a.url), name: String(a.name || 'file').slice(0, 200), type: String(a.type || '').slice(0, 100), size: Number(a.size) || null }));

/** Message as the client sees it (no staff names) */
const forClient = (m) => ({
    id: m.id, from: m.sender_type === 'staff' ? 'support' : 'me', body: m.body, attachments: m.attachments || [],
    order_id: m.order_id, order_number: m.order_number || null, created_at: m.created_at
});
/** Message as staff see it */
const forStaff = (m) => ({
    id: m.id, from: m.sender_type, sender_name: m.sender_name || null, body: m.body, attachments: m.attachments || [],
    order_id: m.order_id, order_number: m.order_number || null, created_at: m.created_at
});

const messageRows = async (conversationId, { before, limit = 50 } = {}) => {
    const params = [conversationId];
    let where = 'm.conversation_id = $1';
    if (before) { params.push(before); where += ` AND m.id < $${params.length}`; }
    params.push(Math.min(100, limit));
    const rows = (await query(
        `SELECT m.*, u.name AS sender_name, mo.order_number
         FROM marketplace_messages m
         LEFT JOIN users u ON u.id = m.sender_user_id
         LEFT JOIN marketplace_orders mo ON mo.id = m.order_id
         WHERE ${where} ORDER BY m.id DESC LIMIT $${params.length}`, params
    )).rows;
    return rows.reverse();
};

/** Is the client connected right now (any open marketplace tab)? */
const clientOnline = async (io, clientId) => {
    try { return io ? (await io.in(`support_client_${clientId}`).fetchSockets()).length > 0 : false; } catch { return false; }
};

/**
 * Save a message and push it live. sender = { type: 'client'|'staff', userId }.
 * Returns the saved message (staff view).
 */
const postMessage = async ({ io, conversation, sender, body, attachments, orderId }) => {
    const text = String(body || '').trim().slice(0, MAX_BODY);
    const files = cleanAttachments(attachments);
    if (!text && !files.length) { const e = new Error('Please write a message or attach a file'); e.statusCode = 400; throw e; }
    const saved = (await query(
        `INSERT INTO marketplace_messages (conversation_id, sender_type, sender_user_id, body, attachments, order_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [conversation.id, sender.type, sender.userId, text, JSON.stringify(files), orderId || null]
    )).rows[0];
    const preview = text ? text.slice(0, 140) : `📎 ${files.map(f => f.name).join(', ')}`.slice(0, 140);
    await query(
        `UPDATE marketplace_conversations
         SET last_message_at = NOW(), last_message_preview = $2, last_sender = $3,
             client_unread = client_unread + $4, staff_unread = staff_unread + $5
         WHERE id = $1`,
        [conversation.id, preview, sender.type, sender.type === 'staff' ? 1 : 0, sender.type === 'client' ? 1 : 0]
    );
    const msg = (await messageRows(conversation.id, { limit: 1 }))[0];
    if (io) {
        io.to(`support_client_${conversation.client_user_id}`).emit('support:message', forClient(msg));
        io.to('support_staff').emit('support:message', { conversation_id: conversation.id, client_user_id: conversation.client_user_id, message: forStaff(msg) });
    }
    if (sender.type === 'staff') notifyClient(io, conversation).catch(err => console.error('[Support] notify failed:', err.message));
    return forStaff(msg);
};

/** One email + bell notification per burst of staff replies, only when the client isn't online */
const notifyClient = async (io, conversation) => {
    if (await clientOnline(io, conversation.client_user_id)) return;
    const claimed = (await query(
        `UPDATE marketplace_conversations SET client_emailed = true WHERE id = $1 AND client_emailed = false RETURNING id`, [conversation.id]
    )).rows[0];
    if (!claimed) return; // already emailed for this burst
    const u = (await query(`SELECT id, name, email, marketplace FROM users WHERE id = $1`, [conversation.client_user_id])).rows[0];
    if (!u) return;
    const brand = mp.getBrand(u.marketplace || conversation.marketplace);
    const name = String(u.name || 'there').replace(/[<>&"]/g, '');
    await query(
        `INSERT INTO notifications (id, type, notifiable_type, notifiable_id, data, created_at, updated_at)
         VALUES ($1, 'support_reply', 'App\\Models\\User', $2, $3, NOW(), NOW())`,
        [require('crypto').randomUUID(), u.id, JSON.stringify({ title: 'New message from Support', message: 'Our support team replied to you.', link: '/support' })]
    ).catch(() => {});
    await sendEmail(u.email, `You have a new message from Support – ${brand.name}`, `
        <h2>Hi ${name},</h2>
        <p>Our support team has replied to your message.</p>
        <p>Log in to read it and reply.</p>
        <a href="${brand.url}/login" class="btn">Log in to read →</a>`, { brand });
};

/** Mark the conversation read by one side */
const markRead = async (conversationId, side) => {
    if (side === 'client') await query(`UPDATE marketplace_conversations SET client_unread = 0, client_emailed = false WHERE id = $1`, [conversationId]);
    else await query(`UPDATE marketplace_conversations SET staff_unread = 0 WHERE id = $1`, [conversationId]);
};

/** socket.io: 'support:join' { token } → joins the right room after checking the login token */
const attachSockets = (io) => {
    io.on('connection', (socket) => {
        socket.on('support:join', async ({ token } = {}) => {
            try {
                const decoded = jwt.verify(String(token || ''), process.env.JWT_SECRET);
                const u = (await query(`SELECT id, role, status, marketplace FROM users WHERE id = $1`, [decoded.id])).rows[0];
                if (!u || u.status !== 1) return socket.emit('support:error', 'not allowed');
                const role = String(u.role || '').toLowerCase();
                if (role === 'client' && u.marketplace && decoded.marketplace === u.marketplace) socket.join(`support_client_${u.id}`);
                else if (STAFF_ROLES.includes(role)) socket.join('support_staff');
                else return socket.emit('support:error', 'not allowed');
                socket.emit('support:joined');
            } catch {
                socket.emit('support:error', 'invalid token');
            }
        });
        // Typing indicator: client → staff, staff → that client (staff shown as "Support Team")
        socket.on('support:typing', ({ to } = {}) => {
            const rooms = [...socket.rooms];
            const clientRoom = rooms.find(r => r.startsWith('support_client_'));
            if (clientRoom) io.to('support_staff').emit('support:typing', { client_user_id: Number(clientRoom.split('_').pop()) });
            else if (rooms.includes('support_staff') && to) io.to(`support_client_${Number(to)}`).emit('support:typing', {});
        });
    });
};

module.exports = { ensureSchema, conversationFor, postMessage, messageRows, markRead, forClient, forStaff, attachSockets, clientOnline, STAFF_ROLES };
