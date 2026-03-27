const { query } = require('../config/database');

/**
 * Chat Controller
 * Handles real-time chat conversations between users
 * Uses 'threads' table with type='CHAT' for conversations
 * and 'thread_messages' table for messages
 */

/**
 * GET /api/chat/users
 * Get list of users available for chat based on role
 * - Manager: sees all Writers, Teams, Bloggers
 * - Writer/Team/Blogger: sees Managers
 */
const getChatUsers = async (req, res, next) => {
    try {
        const { role: rawRole, id: currentUserId } = req.user;
        const role = rawRole ? rawRole.toLowerCase() : '';
        let users;

        if (role === 'manager' || role === 'admin' || role === 'super_admin') {
            // Managers see: all writers + team members + vendors WHO HAVE EXISTING CHATS
            // (don't load all 67k vendors, only those with active conversations)
            const result = await query(
                `SELECT u.id, u.name, u.email, u.role, 
                    COALESCE(u.profile_image, '') as avatar
                 FROM users u
                 WHERE u.role IN ('writer', 'team') 
                   AND u.id != $1
                   AND u.status = 1
                 
                 UNION
                 
                 SELECT u.id, u.name, u.email, u.role,
                    COALESCE(u.profile_image, '') as avatar
                 FROM users u
                 WHERE u.role = 'vendor'
                   AND u.id != $1
                   AND u.status = 1
                   AND EXISTS (
                     SELECT 1 FROM threads t 
                     WHERE t.type = 'CHAT' 
                       AND ((t.owner_id = $1 AND t.user_id = u.id) OR (t.owner_id = u.id AND t.user_id = $1))
                   )
                 
                 ORDER BY role, name`,
                [currentUserId]
            );
            users = result.rows;
        } else if (role === 'vendor') {
            // Bloggers only see the manager who pushed their latest order
            const result = await query(
                `SELECT DISTINCT ON (m.id) m.id, m.name, m.email, m.role,
                    COALESCE(m.profile_image, '') as avatar
                 FROM new_order_process_details nopd
                 JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
                 JOIN new_orders no ON nop.new_order_id = no.id
                 JOIN users m ON no.manager_id = m.id
                 WHERE nopd.vendor_id = $1
                 ORDER BY m.id, nopd.created_at DESC
                 LIMIT 1`,
                [currentUserId]
            );
            users = result.rows;
        } else {
            // Others can chat with Managers
            const result = await query(
                `SELECT id, name, email, role,
                    COALESCE(profile_image, '') as avatar
                 FROM users 
                 WHERE role IN ('manager', 'admin', 'super_admin')
                   AND id != $1
                   AND status = 1
                 ORDER BY name`,
                [currentUserId]
            );
            users = result.rows;
        }

        // For each user, get the last message from their chat thread
        for (const user of users) {
            const threadResult = await query(
                `SELECT t.id as thread_id, 
                    (SELECT tm.message FROM thread_messages tm WHERE tm.thread_id = t.id ORDER BY tm.created_at DESC LIMIT 1) as last_message,
                    (SELECT tm.created_at FROM thread_messages tm WHERE tm.thread_id = t.id ORDER BY tm.created_at DESC LIMIT 1) as last_message_at,
                    (SELECT COUNT(*) FROM thread_messages tm WHERE tm.thread_id = t.id AND tm.user_id != $1 AND tm.is_read = false)::int as unread_count
                 FROM threads t
                 WHERE t.type = 'CHAT'
                   AND ((t.owner_id = $1 AND t.user_id = $2) OR (t.owner_id = $2 AND t.user_id = $1))
                 LIMIT 1`,
                [currentUserId, user.id]
            );

            if (threadResult.rows[0]) {
                user.thread_id = threadResult.rows[0].thread_id;
                user.last_message = threadResult.rows[0].last_message;
                user.last_message_at = threadResult.rows[0].last_message_at;
                user.unread_count = threadResult.rows[0].unread_count;
            } else {
                user.thread_id = null;
                user.last_message = null;
                user.last_message_at = null;
                user.unread_count = 0;
            }
        }

        // Sort by last_message_at (most recent first), users with no messages go to bottom
        users.sort((a, b) => {
            if (!a.last_message_at && !b.last_message_at) return 0;
            if (!a.last_message_at) return 1;
            if (!b.last_message_at) return -1;
            return new Date(b.last_message_at) - new Date(a.last_message_at);
        });

        res.json({ users });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/chat/conversation/:targetUserId
 * Get or create a conversation (thread of type='CHAT') with a target user
 */
const getConversation = async (req, res, next) => {
    try {
        const currentUserId = req.user.id;
        const targetUserId = parseInt(req.params.targetUserId);

        if (currentUserId === targetUserId) {
            return res.status(400).json({ error: 'Cannot chat with yourself' });
        }

        // Check if thread already exists between these two users
        let threadResult = await query(
            `SELECT t.*, 
                u1.name as owner_name, u1.role as owner_role,
                u2.name as user_name, u2.role as user_role
             FROM threads t
             LEFT JOIN users u1 ON t.owner_id = u1.id
             LEFT JOIN users u2 ON t.user_id = u2.id
             WHERE t.type = 'CHAT'
               AND ((t.owner_id = $1 AND t.user_id = $2) OR (t.owner_id = $2 AND t.user_id = $1))
             LIMIT 1`,
            [currentUserId, targetUserId]
        );

        let thread = threadResult.rows[0];

        // If no thread exists, create one
        if (!thread) {
            const createResult = await query(
                `INSERT INTO threads (owner_id, user_id, subject, type)
                 VALUES ($1, $2, 'Chat', 'CHAT')
                 RETURNING *`,
                [currentUserId, targetUserId]
            );
            thread = createResult.rows[0];

            // Re-fetch with user names
            threadResult = await query(
                `SELECT t.*, 
                    u1.name as owner_name, u1.role as owner_role,
                    u2.name as user_name, u2.role as user_role
                 FROM threads t
                 LEFT JOIN users u1 ON t.owner_id = u1.id
                 LEFT JOIN users u2 ON t.user_id = u2.id
                 WHERE t.id = $1`,
                [thread.id]
            );
            thread = threadResult.rows[0];
        }

        res.json({ conversation: thread });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/chat/messages/:threadId
 * Get messages for a conversation with pagination
 */
const getMessages = async (req, res, next) => {
    try {
        const { threadId } = req.params;
        const currentUserId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        // Verify user has access to this thread
        const threadCheck = await query(
            `SELECT id FROM threads 
             WHERE id = $1 AND type = 'CHAT'
               AND (owner_id = $2 OR user_id = $2)`,
            [threadId, currentUserId]
        );

        if (!threadCheck.rows[0]) {
            return res.status(403).json({ error: 'Access denied to this conversation' });
        }

        // Get messages (newest first for pagination, reversed on frontend)
        const messagesResult = await query(
            `SELECT tm.id, tm.thread_id, tm.user_id, tm.message, 
                    tm.attachments, tm.is_read, tm.created_at,
                    u.name as sender_name, u.role as sender_role,
                    COALESCE(u.profile_image, '') as sender_avatar
             FROM thread_messages tm
             LEFT JOIN users u ON tm.user_id = u.id
             WHERE tm.thread_id = $1
             ORDER BY tm.created_at DESC
             LIMIT $2 OFFSET $3`,
            [threadId, limit, offset]
        );

        // Get total count
        const countResult = await query(
            'SELECT COUNT(*)::int as total FROM thread_messages WHERE thread_id = $1',
            [threadId]
        );

        // Mark messages as read
        await query(
            `UPDATE thread_messages 
             SET is_read = true 
             WHERE thread_id = $1 AND user_id != $2 AND is_read = false`,
            [threadId, currentUserId]
        );

        res.json({
            messages: messagesResult.rows, // Newest first
            total: countResult.rows[0].total,
            page,
            limit,
            hasMore: offset + limit < countResult.rows[0].total
        });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/chat/messages/:threadId
 * Send a message to a conversation
 */
const sendMessage = async (req, res, next) => {
    try {
        const { threadId } = req.params;
        const currentUserId = req.user.id;
        const { message, attachments } = req.body;

        if (!message || message.trim().length === 0) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }

        // Verify user has access to this thread
        const threadCheck = await query(
            `SELECT id, owner_id, user_id FROM threads 
             WHERE id = $1 AND type = 'CHAT'
               AND (owner_id = $2 OR user_id = $2)`,
            [threadId, currentUserId]
        );

        if (!threadCheck.rows[0]) {
            return res.status(403).json({ error: 'Access denied to this conversation' });
        }

        // Insert message
        const messageResult = await query(
            `INSERT INTO thread_messages (thread_id, user_id, message, attachments)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [threadId, currentUserId, message.trim(), attachments ? JSON.stringify(attachments) : null]
        );

        // Update thread timestamp
        await query(
            'UPDATE threads SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [threadId]
        );

        // Get full message with sender info
        const fullMessage = await query(
            `SELECT tm.*, u.name as sender_name, u.role as sender_role,
                    COALESCE(u.profile_image, '') as sender_avatar
             FROM thread_messages tm
             LEFT JOIN users u ON tm.user_id = u.id
             WHERE tm.id = $1`,
            [messageResult.rows[0].id]
        );

        const savedMessage = fullMessage.rows[0];

        // Emit via Socket.io for real-time
        const io = req.app.get('io');
        if (io) {
            io.to(`chat_${threadId}`).emit('new_message', savedMessage);
        }

        res.status(201).json({ message: savedMessage });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/chat/messages/:threadId/read
 * Mark all messages in a thread as read
 */
const markAsRead = async (req, res, next) => {
    try {
        const { threadId } = req.params;
        const currentUserId = req.user.id;

        await query(
            `UPDATE thread_messages 
             SET is_read = true 
             WHERE thread_id = $1 AND user_id != $2 AND is_read = false`,
            [threadId, currentUserId]
        );

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/chat/unread-count
 * Get total unread message count for current user
 */
const getUnreadCount = async (req, res, next) => {
    try {
        const currentUserId = req.user.id;

        const result = await query(
            `SELECT COUNT(*)::int as unread_count
             FROM thread_messages tm
             JOIN threads t ON tm.thread_id = t.id
             WHERE t.type = 'CHAT'
               AND (t.owner_id = $1 OR t.user_id = $1)
               AND tm.user_id != $1
               AND tm.is_read = false`,
            [currentUserId]
        );

        res.json({ unread_count: result.rows[0].unread_count });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/chat/search-users?q=searchTerm
 * Search for users to start a new conversation with
 * Managers: search among writers, team, vendors
 * Others: search among managers
 */
const searchUsers = async (req, res, next) => {
    try {
        const { role: rawRole, id: currentUserId } = req.user;
        const role = rawRole ? rawRole.toLowerCase() : '';
        const searchTerm = (req.query.q || '').trim();

        if (searchTerm.length < 2) {
            return res.json({ users: [] });
        }

        let users;

        if (role === 'manager' || role === 'admin' || role === 'super_admin') {
            // Search among writers, team, vendors
            const result = await query(
                `SELECT id, name, email, role, 
                    COALESCE(profile_image, '') as avatar
                 FROM users 
                 WHERE role IN ('writer', 'team', 'vendor') 
                   AND id != $1
                   AND status = 1
                   AND (LOWER(name) LIKE $2 OR LOWER(email) LIKE $2)
                 ORDER BY 
                   CASE WHEN LOWER(name) LIKE $3 THEN 0 ELSE 1 END,
                   role, name
                 LIMIT 30`,
                [currentUserId, `%${searchTerm.toLowerCase()}%`, `${searchTerm.toLowerCase()}%`]
            );
            users = result.rows;
        } else if (role === 'vendor') {
            // Bloggers only search their latest manager
            const result = await query(
                `SELECT DISTINCT ON (m.id) m.id, m.name, m.email, m.role,
                    COALESCE(m.profile_image, '') as avatar
                 FROM new_order_process_details nopd
                 JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
                 JOIN new_orders no ON nop.new_order_id = no.id
                 JOIN users m ON no.manager_id = m.id
                 WHERE nopd.vendor_id = $1
                 ORDER BY m.id, nopd.created_at DESC
                 LIMIT 1`,
                [currentUserId]
            );
            users = result.rows;
        } else {
            // Search among managers
            const result = await query(
                `SELECT id, name, email, role,
                    COALESCE(profile_image, '') as avatar
                 FROM users 
                 WHERE role IN ('manager', 'admin', 'super_admin')
                   AND id != $1
                   AND status = 1
                   AND (LOWER(name) LIKE $2 OR LOWER(email) LIKE $2)
                 ORDER BY name
                 LIMIT 30`,
                [currentUserId, `%${searchTerm.toLowerCase()}%`]
            );
            users = result.rows;
        }

        res.json({ users });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getChatUsers,
    getConversation,
    getMessages,
    sendMessage,
    markAsRead,
    getUnreadCount,
    searchUsers
};
