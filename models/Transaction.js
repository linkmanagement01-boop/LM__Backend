const { query } = require('../config/database');

/**
 * Transaction Model - Production Database Compatible
 * Handles blogger/vendor withdrawal requests and payment processing
 * 
 * Production schema mapping:
 * - transactions → withdraw_requests + wallet_histories
 * - Status codes: 0=Pending, 1=Approved, 2=Rejected
 */

// Status mapping
const STATUS_MAP = {
    'Requested': 0,
    'Processing': 0,
    'Paid': 1,
    'Rejected': 2
};

const STATUS_MAP_REVERSE = {
    0: 'Requested',
    1: 'Paid',
    2: 'Rejected'
};

class Transaction {
    /**
     * Get all transactions (withdrawal requests)
     */
    static async findAll(filters = {}) {
        let sql = `
            SELECT 
                wr.id,
                wr.user_id,
                wr.status,
                wr.invoice_number,
                wr.invoice_file,
                wr.created_at as request_date,
                wr.updated_at as processed_date,
                u.name as user_name,
                u.email as user_email,
                COALESCE((
                    SELECT SUM(wh.price) FROM wallet_histories wh 
                    WHERE wh.withdraw_request_id = wr.id
                ), 0) as amount
            FROM withdraw_requests wr
            JOIN users u ON wr.user_id = u.id
            WHERE 1=1
        `;

        const params = [];
        let paramIndex = 1;

        if (filters.user_id) {
            sql += ` AND wr.user_id = $${paramIndex}`;
            params.push(filters.user_id);
            paramIndex++;
        }

        if (filters.status) {
            const dbStatus = STATUS_MAP[filters.status];
            if (dbStatus !== undefined) {
                sql += ` AND wr.status = $${paramIndex}`;
                params.push(dbStatus);
                paramIndex++;
            }
        }

        sql += ' ORDER BY wr.created_at DESC LIMIT 100';

        const result = await query(sql, params);
        return result.rows.map(row => ({
            ...row,
            status: STATUS_MAP_REVERSE[row.status] || 'Requested'
        }));
    }

    /**
     * Find transaction by ID
     */
    static async findById(id) {
        const result = await query(
            `SELECT 
                wr.id,
                wr.user_id,
                wr.status,
                wr.invoice_number,
                wr.invoice_file,
                wr.created_at as request_date,
                wr.updated_at as processed_date,
                u.name as user_name,
                u.email as user_email,
                COALESCE((
                    SELECT SUM(wh.price) FROM wallet_histories wh 
                    WHERE wh.withdraw_request_id = wr.id
                ), 0) as amount
            FROM withdraw_requests wr
            JOIN users u ON wr.user_id = u.id
            WHERE wr.id = $1`,
            [id]
        );

        if (result.rows[0]) {
            result.rows[0].status = STATUS_MAP_REVERSE[result.rows[0].status] || 'Requested';
        }
        return result.rows[0];
    }

    /**
     * Create withdrawal request
     */
    static async create(userId, amount, notes = null) {
        // Create withdraw request
        const result = await query(
            `INSERT INTO withdraw_requests (user_id, status) 
             VALUES ($1, 0) 
             RETURNING *`,
            [userId]
        );

        const withdrawRequest = result.rows[0];

        // Create wallet history entry
        await query(
            `INSERT INTO wallet_histories (
                wallet_id, type, price, status, remarks, withdraw_request_id, request_date
            ) 
            SELECT w.id, 'debit', $1, 0, $2, $3, CURRENT_TIMESTAMP
            FROM wallets w WHERE w.user_id = $4`,
            [amount, notes, withdrawRequest.id, userId]
        );

        return {
            ...withdrawRequest,
            amount,
            status: 'Requested',
            request_date: withdrawRequest.created_at
        };
    }

    /**
     * Approve withdrawal
     */
    static async approve(id, processedBy) {
        // Update withdraw request
        const result = await query(
            `UPDATE withdraw_requests 
             SET status = 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING *`,
            [id]
        );

        // Update wallet history
        await query(
            `UPDATE wallet_histories 
             SET status = 1, approved_date = CURRENT_TIMESTAMP
             WHERE withdraw_request_id = $1`,
            [id]
        );

        if (result.rows[0]) {
            result.rows[0].status = 'Paid';
        }
        return result.rows[0];
    }

    /**
     * Reject withdrawal
     */
    static async reject(id, processedBy, rejectionReason) {
        // Update withdraw request
        const result = await query(
            `UPDATE withdraw_requests 
             SET status = 2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING *`,
            [id]
        );

        // Update wallet history
        await query(
            `UPDATE wallet_histories 
             SET status = 2, remarks = $1
             WHERE withdraw_request_id = $2`,
            [rejectionReason, id]
        );

        if (result.rows[0]) {
            result.rows[0].status = 'Rejected';
            result.rows[0].rejection_reason = rejectionReason;
        }
        return result.rows[0];
    }

    /**
     * Get total withdrawn amount for a user
     * Uses withdraw_requests table to track paid withdrawals
     */
    static async getTotalWithdrawn(userId) {
        const result = await query(
            `SELECT COALESCE(SUM(wh.price), 0) as total 
             FROM wallet_histories wh
             JOIN wallets w ON wh.wallet_id = w.id
             JOIN withdraw_requests wr ON wh.withdraw_request_id = wr.id
             WHERE w.user_id = $1 AND wr.status = 1`,
            [userId]
        );

        return parseFloat(result.rows[0].total);
    }

    /**
     * Get pending withdrawal amount for a user
     * Uses withdraw_requests table to track pending withdrawals
     */
    static async getPendingAmount(userId) {
        const result = await query(
            `SELECT COALESCE(SUM(wh.price), 0) as total 
             FROM wallet_histories wh
             JOIN wallets w ON wh.wallet_id = w.id
             JOIN withdraw_requests wr ON wh.withdraw_request_id = wr.id
             WHERE w.user_id = $1 AND wr.status = 0`,
            [userId]
        );

        return parseFloat(result.rows[0].total);
    }

    /**
     * Get wallet history for a user - matches production table format
     * Columns: Date, Order ID (with URL), Credit, Withdrawal Status, Approved Status
     * Uses site prices as fallback when wallet_history price is 0 (from orders credited before price fix)
     */
    static async getWalletHistory(userId, limit = 500) {
        const result = await query(
            `SELECT 
                wh.id,
                wh.order_detail_id,
                CASE 
                    WHEN LOWER(no.order_type) LIKE '%niche%' OR LOWER(no.order_type) LIKE '%edit%' OR LOWER(no.order_type) LIKE '%insertion%'
                        THEN CASE 
                            WHEN no.fc = 1 AND ns.fc_ne IS NOT NULL AND REGEXP_REPLACE(ns.fc_ne::text, '[^0-9.]', '', 'g') ~ '^[0-9]+(\.[0-9]+)?$' AND REGEXP_REPLACE(ns.fc_ne::text, '[^0-9.]', '', 'g')::DOUBLE PRECISION > 0
                                THEN REGEXP_REPLACE(ns.fc_ne::text, '[^0-9.]', '', 'g')::DOUBLE PRECISION
                            WHEN REGEXP_REPLACE(COALESCE(ns.niche_edit_price::text,'0'), '[^0-9.]', '', 'g') ~ '^[0-9]+(\.[0-9]+)?$'
                                THEN REGEXP_REPLACE(ns.niche_edit_price::text, '[^0-9.]', '', 'g')::DOUBLE PRECISION
                            ELSE 0 END
                    ELSE CASE 
                            WHEN no.fc = 1 AND ns.fc_gp IS NOT NULL AND REGEXP_REPLACE(ns.fc_gp::text, '[^0-9.]', '', 'g') ~ '^[0-9]+(\.[0-9]+)?$' AND REGEXP_REPLACE(ns.fc_gp::text, '[^0-9.]', '', 'g')::DOUBLE PRECISION > 0
                                THEN REGEXP_REPLACE(ns.fc_gp::text, '[^0-9.]', '', 'g')::DOUBLE PRECISION
                            WHEN REGEXP_REPLACE(COALESCE(ns.gp_price::text,'0'), '[^0-9.]', '', 'g') ~ '^[0-9]+(\.[0-9]+)?$'
                                THEN REGEXP_REPLACE(ns.gp_price::text, '[^0-9.]', '', 'g')::DOUBLE PRECISION
                            ELSE 0 END
                END as credit,
                wh.type,
                wh.status,
                wh.created_at as date,
                wh.request_date,
                wh.approved_date,
                nopd.submit_url,
                ns.root_domain,
                no.order_id as order_id
             FROM wallet_histories wh
             JOIN wallets w ON wh.wallet_id = w.id
             LEFT JOIN new_order_process_details nopd ON wh.order_detail_id = nopd.id
             LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
             LEFT JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             LEFT JOIN new_orders no ON nop.new_order_id = no.id
             WHERE w.user_id = $1
             ORDER BY wh.created_at DESC
             LIMIT $2`,
            [userId, limit]
        );

        return result.rows;
    }
}


module.exports = Transaction;
