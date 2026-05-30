const { query } = require('../config/database');
const logger = require('../utils/logger');
const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Applies tiered markup logic for the Client Dashboard.
 * Website price tiers:
 * - If website price = $10 -> Client Dashboard price = $30
 * - If website price is between $11-$25 -> price = $50
 * - If website price is between $26-$50 -> price = $79
 * - If website price is between $51-$79 -> price = $100
 * - If website price is between $80-$99 -> price = $130
 * - If website price is $100 or above -> increase by 30%
 */
function applyClientMarkup(priceStr) {
    if (priceStr === null || priceStr === undefined) return priceStr;
    const price = parseFloat(priceStr.toString().replace(/[^0-9.]/g, ''));
    if (isNaN(price)) return priceStr;
    
    if (price <= 10) return 30;
    if (price <= 25) return 50;
    if (price <= 50) return 79;
    if (price <= 79) return 100;
    if (price < 100) return 130;
    
    // For >= 100, we increase the price by 30% and round to 2 decimal places
    const markedUp = price * 1.30;
    return Math.round(markedUp * 100) / 100;
}

/**
 * Client Controller
 * Handles all client panel operations: dashboard, wallet, payments, sites, orders
 */

// ==================== Dashboard ====================

/**
 * @route   GET /api/client/dashboard
 * @desc    Get client dashboard stats
 * @access  Private (Client)
 */
const getDashboard = async (req, res, next) => {
    try {
        const clientId = req.user.id;

        // Get wallet balance
        const walletResult = await query(
            'SELECT COALESCE(balance, 0) as balance FROM wallets WHERE user_id = $1',
            [clientId]
        );
        const walletBalance = walletResult.rows[0]?.balance || 0;

        // Get total orders count
        const ordersResult = await query(
            `SELECT COUNT(*) as total_orders FROM client_orders WHERE client_user_id = $1`,
            [clientId]
        );

        // Get orders by status
        const statusResult = await query(
            `SELECT status, COUNT(*) as count FROM client_orders WHERE client_user_id = $1 GROUP BY status`,
            [clientId]
        );

        const statusCounts = {};
        (statusResult.rows || []).forEach(r => {
            statusCounts[r.status] = parseInt(r.count);
        });

        // Get total spent
        const spentResult = await query(
            `SELECT COALESCE(SUM(amount), 0) as total_spent 
             FROM client_payments 
             WHERE client_user_id = $1 AND status = 'completed'`,
            [clientId]
        );

        res.json({
            wallet_balance: parseFloat(walletBalance),
            total_orders: parseInt(ordersResult.rows[0]?.total_orders || 0),
            orders_by_status: statusCounts,
            total_spent: parseFloat(spentResult.rows[0]?.total_spent || 0)
        });
    } catch (error) {
        logger.error('Client:Dashboard', error);
        next(error);
    }
};

// ==================== Wallet & Payments ====================

/**
 * @route   GET /api/client/wallet
 * @desc    Get client wallet balance and recent transactions
 * @access  Private (Client)
 */
const getWallet = async (req, res, next) => {
    try {
        const clientId = req.user.id;

        const walletResult = await query(
            'SELECT COALESCE(balance, 0) as balance FROM wallets WHERE user_id = $1',
            [clientId]
        );

        const paymentsResult = await query(
            `SELECT id, amount, currency, status, razorpay_order_id, razorpay_payment_id, created_at 
             FROM client_payments 
             WHERE client_user_id = $1 
             ORDER BY created_at DESC 
             LIMIT 50`,
            [clientId]
        );

        res.json({
            balance: parseFloat(walletResult.rows[0]?.balance || 0),
            transactions: paymentsResult.rows
        });
    } catch (error) {
        logger.error('Client:Wallet', error);
        next(error);
    }
};

/**
 * @route   POST /api/client/payments/create-order
 * @desc    Create a Razorpay order for top-up
 * @access  Private (Client)
 */
const createPaymentOrder = async (req, res, next) => {
    try {
        const clientId = req.user.id;
        const { amount } = req.body;

        // Validate amount
        const allowedAmounts = [500, 1000, 1500, 2000];
        if (!allowedAmounts.includes(Number(amount))) {
            return res.status(400).json({
                error: 'Invalid Amount',
                message: `Amount must be one of: $${allowedAmounts.join(', $')}`
            });
        }

        // Check if Razorpay keys are configured
        const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
        const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;

        if (!razorpayKeyId || !razorpayKeySecret) {
            return res.status(503).json({
                error: 'Payment Not Configured',
                message: 'Razorpay payment gateway is not configured yet. Please contact admin.'
            });
        }

        // Create Razorpay order
        const Razorpay = require('razorpay');
        const razorpay = new Razorpay({
            key_id: razorpayKeyId,
            key_secret: razorpayKeySecret
        });

        const amountInPaise = Math.round(amount * 100); // Razorpay expects amount in smallest currency unit

        const razorpayOrder = await razorpay.orders.create({
            amount: amountInPaise,
            currency: 'USD',
            receipt: `client_${clientId}_${Date.now()}`,
            notes: {
                client_user_id: clientId.toString(),
                purpose: 'wallet_topup'
            }
        });

        // Save payment record in DB
        await query(
            `INSERT INTO client_payments (client_user_id, amount, currency, status, razorpay_order_id, created_at) 
             VALUES ($1, $2, 'USD', 'pending', $3, CURRENT_TIMESTAMP)`,
            [clientId, amount, razorpayOrder.id]
        );

        res.json({
            order_id: razorpayOrder.id,
            amount: amount,
            currency: 'USD',
            key_id: razorpayKeyId  // Frontend needs this to open Razorpay checkout
        });
    } catch (error) {
        logger.error('Client:CreatePaymentOrder', error);
        next(error);
    }
};

/**
 * @route   POST /api/client/payments/verify
 * @desc    Verify Razorpay payment after checkout and credit wallet
 * @access  Private (Client)
 */
const verifyPayment = async (req, res, next) => {
    try {
        const clientId = req.user.id;
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({
                error: 'Missing Fields',
                message: 'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required'
            });
        }

        // Verify signature
        const crypto = require('crypto');
        const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;
        const generatedSignature = crypto
            .createHmac('sha256', razorpayKeySecret)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');

        if (generatedSignature !== razorpay_signature) {
            // Mark payment as failed
            await query(
                `UPDATE client_payments SET status = 'failed' WHERE razorpay_order_id = $1 AND client_user_id = $2`,
                [razorpay_order_id, clientId]
            );
            return res.status(400).json({
                error: 'Payment Verification Failed',
                message: 'Invalid payment signature. Payment has been marked as failed.'
            });
        }

        // Get payment record to find the amount
        const paymentRecord = await query(
            `SELECT id, amount, status FROM client_payments WHERE razorpay_order_id = $1 AND client_user_id = $2`,
            [razorpay_order_id, clientId]
        );

        if (paymentRecord.rows.length === 0) {
            return res.status(404).json({ error: 'Payment record not found' });
        }

        if (paymentRecord.rows[0].status === 'completed') {
            return res.status(400).json({ error: 'Payment already processed' });
        }

        const amount = parseFloat(paymentRecord.rows[0].amount);

        // Update payment record
        await query(
            `UPDATE client_payments 
             SET status = 'completed', razorpay_payment_id = $1, updated_at = CURRENT_TIMESTAMP 
             WHERE razorpay_order_id = $2 AND client_user_id = $3`,
            [razorpay_payment_id, razorpay_order_id, clientId]
        );

        // Credit wallet
        const walletCheck = await query('SELECT id FROM wallets WHERE user_id = $1', [clientId]);
        let walletId;
        if (walletCheck.rows.length === 0) {
            const insertResult = await query(
                'INSERT INTO wallets (user_id, balance, created_at) VALUES ($1, $2, CURRENT_TIMESTAMP) RETURNING id',
                [clientId, amount]
            );
            walletId = insertResult.rows[0].id;
        } else {
            await query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [amount, clientId]);
            walletId = walletCheck.rows[0].id;
        }

        // Log transaction in wallet_histories
        await query(
            `INSERT INTO wallet_histories (wallet_id, type, price, remarks, status, created_at, updated_at, approved_date)
             VALUES ($1, 'Credit', $2, $3, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [walletId, amount, `Wallet Topup (Razorpay Order: ${razorpay_order_id})`]
        );

        // Get updated balance
        const updatedWallet = await query('SELECT balance FROM wallets WHERE user_id = $1', [clientId]);

        logger.info('Client:Payment', `Payment verified. Client ${clientId} credited $${amount}`);

        res.json({
            message: 'Payment verified and wallet credited successfully',
            credited_amount: amount,
            new_balance: parseFloat(updatedWallet.rows[0]?.balance || 0)
        });
    } catch (error) {
        logger.error('Client:VerifyPayment', error);
        next(error);
    }
};

// ==================== Sites ====================

/**
 * @route   GET /api/client/sites
 * @desc    Get all approved sites for clients to browse
 * @access  Private (Client)
 */
const getSites = async (req, res, next) => {
    try {
        const { page = 1, limit = 20, search_domain, search_category, filter_traffic_val, filter_traffic_op } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = `WHERE (ns.delete_site IS NULL OR ns.delete_site = 0) AND ns.site_status = '1'`;
        const params = [];
        let paramIndex = 1;

        if (search_domain) {
            whereClause += ` AND ns.root_domain ILIKE $${paramIndex}`;
            params.push(`%${search_domain}%`);
            paramIndex++;
        }

        if (search_category) {
            whereClause += ` AND (ns.category ILIKE $${paramIndex} OR ns.website_niche ILIKE $${paramIndex})`;
            params.push(`%${search_category}%`);
            paramIndex++;
        }

        if (filter_traffic_val) {
            const op = filter_traffic_op === '<' ? '<' : '>';
            // Need to cast text to numeric safely
            const castCol = `(CASE WHEN ns.traffic_source::text ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.traffic_source::numeric ELSE 0 END)`;
            whereClause += ` AND ${castCol} ${op} $${paramIndex}`;
            params.push(Number(filter_traffic_val));
            paramIndex++;
        }

        // Count total
        const countResult = await query(
            `SELECT COUNT(*) as total FROM new_sites ns ${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].total);

        // Fetch sites
        const sitesResult = await query(
            `SELECT ns.id, ns.root_domain, ns.category, ns.website_niche, ns.da, ns.dr, ns.traffic_source as traffic, 
                    ns.rd, ns.spam_score, ns.gp_price, ns.niche_edit_price, ns.website_status,
                    ns.link_type, ns.domain_type, ns.word_count, ns.sample_url,
                    ns.fc_gp, ns.fc_ne
             FROM new_sites ns 
             ${whereClause} 
             ORDER BY ns.created_at DESC 
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            [...params, parseInt(limit), parseInt(offset)]
        );

        const markedUpSites = (sitesResult.rows || []).map(site => ({
            ...site,
            gp_price: applyClientMarkup(site.gp_price),
            niche_edit_price: applyClientMarkup(site.niche_edit_price)
        }));

        res.json({
            sites: markedUpSites,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        logger.error('Client:Sites', error);
        next(error);
    }
};

// ==================== Client Orders ====================

/**
 * @route   POST /api/client/orders
 * @desc    Create a new client order (GP or Niche Edit)
 * @access  Private (Client)
 */
const createOrder = async (req, res, next) => {
    try {
        const clientId = req.user.id;
        const {
            order_type,      // 'Guest Post' or 'Niche Edit'
            websites,        // Array of website selections with optional details
            fill_details,    // Boolean: true if client fills details, false if delegate to manager
            notes,
            order_package,
            category
        } = req.body;

        if (!order_type || !websites || websites.length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Order type and at least one website are required'
            });
        }

        // 1. Calculate total price and per-site marked-up prices
        let totalPrice = 0;
        const siteIds = websites.map(w => w.site_id);
        const sitePriceMap = {}; // { site_id: markedUpPrice }
        
        if (siteIds.length > 0) {
            const placeholders = siteIds.map((_, i) => `$${i + 1}`).join(',');
            const sitesResult = await query(
                `SELECT id, gp_price, niche_edit_price FROM new_sites WHERE id IN (${placeholders})`,
                siteIds
            );
            
            for (const site of websites) {
                const dbSite = sitesResult.rows.find(r => r.id === site.site_id);
                if (dbSite) {
                    const priceStr = order_type === 'Guest Post' ? dbSite.gp_price : dbSite.niche_edit_price;
                    const markedUpPrice = applyClientMarkup(priceStr);
                    if (markedUpPrice !== null && markedUpPrice !== undefined) {
                        const parsed = parseFloat(markedUpPrice.toString().replace(/[^0-9.]/g, ''));
                        if (!isNaN(parsed)) {
                            totalPrice += parsed;
                            sitePriceMap[site.site_id] = parsed;
                        }
                    }
                }
            }
        }

        // 2. Check wallet balance
        const walletResult = await query('SELECT id, balance FROM wallets WHERE user_id = $1', [clientId]);
        if (walletResult.rows.length === 0) {
            return res.status(400).json({
                error: 'Wallet Error',
                message: 'User wallet not found'
            });
        }

        const walletId = walletResult.rows[0].id;
        const currentBalance = parseFloat(walletResult.rows[0].balance || 0);

        if (currentBalance < totalPrice) {
            return res.status(400).json({
                error: 'Insufficient Balance',
                message: `Your wallet balance ($${currentBalance.toFixed(2)}) is lower than the order total ($${totalPrice.toFixed(2)}). Please top up your wallet first.`
            });
        }

        // 3. Deduct from wallet atomically
        const newBalance = currentBalance - totalPrice;
        await query(
            'UPDATE wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [newBalance, walletId]
        );

        // 4.5 Round Robin Manager Assignment
        let assignedManagerId = null;
        try {
            // Fetch all active managers ordered by ID
            const activeManagersRes = await query(`
                SELECT id FROM users 
                WHERE role = 'manager' AND status = 1 
                ORDER BY id ASC
            `);
            // Parse to integers to handle database bigints parsed as strings in JavaScript
            const activeManagers = activeManagersRes.rows.map(r => parseInt(r.id, 10));

            if (activeManagers.length > 0) {
                // Get the last assigned manager from client_orders
                const lastAssignedRes = await query(`
                    SELECT assigned_to 
                    FROM client_orders 
                    WHERE assigned_to IS NOT NULL 
                    ORDER BY created_at DESC 
                    LIMIT 1
                `);

                if (lastAssignedRes.rows.length === 0) {
                    assignedManagerId = activeManagers[0];
                } else {
                    // Parse assigned_to column to integer as well for safe indexOf matching
                    const lastAssignedId = parseInt(lastAssignedRes.rows[0].assigned_to, 10);
                    const lastIndex = activeManagers.indexOf(lastAssignedId);

                    if (lastIndex === -1) {
                        assignedManagerId = activeManagers[0];
                    } else {
                        const nextIndex = (lastIndex + 1) % activeManagers.length;
                        assignedManagerId = activeManagers[nextIndex];
                    }
                }
            }
        } catch (err) {
            console.error('Error in round robin assignment:', err);
        }

        // 5. Create client order
        const clientUserRes = await query('SELECT name FROM users WHERE id = $1', [clientId]);
        const clientName = clientUserRes.rows[0]?.name || 'Client';
        const cleanName = clientName.replace(/[^a-zA-Z0-9]/g, '') || 'Client';

        const countRes = await query('SELECT COUNT(*) as count FROM client_orders WHERE client_user_id = $1', [clientId]);
        const orderSequence = parseInt(countRes.rows[0].count, 10) + 1;
        const paddedSequence = String(orderSequence).padStart(5, '0');
        const orderNumber = `${cleanName}-${paddedSequence}`;

        const globalFillDetails = websites.every(w => w.fill_details !== false);
        const orderResult = await query(
            `INSERT INTO client_orders 
             (client_user_id, order_type, no_of_links, status, fill_details, notes, order_package, category, total_price, assigned_to, assigned_at, created_at, order_number) 
             VALUES ($1, $2, $3, 'pending_review', $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, $11) 
             RETURNING id, order_number`,
            [
                clientId, 
                order_type, 
                websites.length, 
                globalFillDetails, 
                notes || '', 
                order_package || '', 
                category || '', 
                totalPrice,
                assignedManagerId,
                assignedManagerId ? new Date() : null,
                orderNumber
            ]
        );

        const clientOrderId = orderResult.rows[0].id;

        // 4. Log transaction in wallet_histories
        await query(
            `INSERT INTO wallet_histories (wallet_id, type, price, remarks, status, created_at, updated_at, approved_date)
             VALUES ($1, 'Debit', $2, $3, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [walletId, totalPrice, `Payment for ${order_type} Order ${orderNumber} (${websites.length} sites)`]
        );

        // Insert website details for each selected site (including marked-up price for refund tracking)
        for (const site of websites) {
            await query(
                `INSERT INTO client_order_details 
                 (client_order_id, site_id, target_url, anchor_text, article_title, doc_url, 
                  post_url, insert_after, insert_statement, note, fill_details, price, created_at) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)`,
                [
                    clientOrderId,
                    site.site_id,
                    site.target_url || null,
                    site.anchor_text || null,
                    site.article_title || null,
                    site.doc_url || null,
                    site.post_url || null,
                    site.insert_after || null,
                    site.insert_statement || null,
                    site.note || null,
                    site.fill_details !== false,
                    sitePriceMap[site.site_id] || null
                ]
            );
        }

        logger.info('Client:Order', `Client ${clientId} created order #${clientOrderId} with ${websites.length} sites`);

        res.status(201).json({
            message: 'Order created successfully. Manager will review it shortly.',
            order_id: clientOrderId,
            order_number: orderResult.rows[0].order_number
        });
    } catch (error) {
        logger.error('Client:CreateOrder', error);
        next(error);
    }
};

/**
 * @route   GET /api/client/orders
 * @desc    Get all orders for the logged-in client
 * @access  Private (Client)
 */
const getOrders = async (req, res, next) => {
    try {
        const clientId = req.user.id;
        const { page = 1, limit = 20, status } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = 'WHERE co.client_user_id = $1';
        const params = [clientId];
        let paramIndex = 2;

        if (status) {
            whereClause += ` AND co.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        const countResult = await query(
            `SELECT COUNT(*) as total FROM client_orders co ${whereClause}`,
            params
        );

        const ordersResult = await query(
            `SELECT co.*, 
                    (SELECT COUNT(*) FROM client_order_details cod WHERE cod.client_order_id = co.id) as site_count,
                    CASE 
                        WHEN co.status = 'COMPLETED_REJECTED' THEN 'completed_with_rejections'
                        WHEN no.id IS NOT NULL THEN 
                            CASE 
                                WHEN no.new_order_status = 6 THEN 'rejected'
                                WHEN no.new_order_status = 5 THEN 'completed'
                                ELSE 'pushed_to_blogger'
                            END
                        ELSE co.status 
                    END as status
             FROM client_orders co 
             LEFT JOIN new_orders no ON co.linked_new_order_id = no.id
             ${whereClause} 
             ORDER BY co.created_at DESC 
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            [...params, parseInt(limit), parseInt(offset)]
        );

        res.json({
            orders: ordersResult.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(countResult.rows[0].total),
                totalPages: Math.ceil(parseInt(countResult.rows[0].total) / limit)
            }
        });
    } catch (error) {
        logger.error('Client:GetOrders', error);
        next(error);
    }
};

/**
 * @route   GET /api/client/orders/:id
 * @desc    Get single order details with site details
 * @access  Private (Client)
 */
const getOrderDetails = async (req, res, next) => {
    try {
        const clientId = req.user.id;
        const orderId = req.params.id;

        const orderResult = await query(
            `SELECT co.*,
                    CASE 
                        WHEN co.status = 'COMPLETED_REJECTED' THEN 'completed_with_rejections'
                        WHEN no.id IS NOT NULL THEN 
                            CASE 
                                WHEN no.new_order_status = 6 THEN 'rejected'
                                WHEN no.new_order_status = 5 THEN 'completed'
                                ELSE 'pushed_to_blogger'
                            END
                        ELSE co.status 
                    END as status
             FROM client_orders co 
             LEFT JOIN new_orders no ON co.linked_new_order_id = no.id
             WHERE co.id = $1 AND co.client_user_id = $2`,
            [orderId, clientId]
        );

        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const order = orderResult.rows[0];

        // Fetch site details with per-site status from new_order_process_details
        const detailsResult = await query(
            `SELECT cod.*, ns.root_domain, ns.da, ns.dr, ns.traffic, ns.gp_price, ns.niche_edit_price, ns.category as site_category,
                    nopd.status as process_status, nopd.submit_url, nopd.reject_reason
             FROM client_order_details cod 
             LEFT JOIN new_sites ns ON ns.id = cod.site_id 
             LEFT JOIN new_order_processes nop ON nop.new_order_id = $2
             LEFT JOIN new_order_process_details nopd ON nopd.new_order_process_id = nop.id AND nopd.new_site_id = cod.site_id
             WHERE cod.client_order_id = $1 
             ORDER BY cod.id`,
            [orderId, order.linked_new_order_id || 0]
        );

        const markedUpDetails = (detailsResult.rows || []).map(row => {
            // Determine per-site status for client display
            let site_status = 'pending';
            if (row.process_status === 8) site_status = 'completed';
            else if (row.process_status === 12) site_status = 'rejected';
            else if (row.process_status === 11) site_status = 'revision';
            else if (row.process_status && row.process_status >= 1) site_status = 'in_progress';

            return {
                ...row,
                gp_price: applyClientMarkup(row.gp_price),
                niche_edit_price: applyClientMarkup(row.niche_edit_price),
                site_status,
                live_url: row.submit_url || null,
                site_reject_reason: row.reject_reason || null
            };
        });

        res.json({
            order,
            details: markedUpDetails
        });
    } catch (error) {
        logger.error('Client:OrderDetails', error);
        next(error);
    }
};

/**
 * @route   GET /api/client/sites/link-completed
 * @desc    Get completed links for client
 */
const getCompletedLinks = async (req, res, next) => {
    try {
        const { year, page = 1, limit = 50, status } = req.query;
        const offset = (page - 1) * limit;
        const clientId = req.user.id;

        // Base where clause including client filter
        let whereClause = `WHERE co.client_user_id = $1 AND nopd.submit_url IS NOT NULL AND nopd.submit_url != ''`;
        const params = [clientId];

        if (year) {
            params.push(year);
            whereClause += ` AND EXTRACT(YEAR FROM nopd.updated_at) = $${params.length}`;
        }

        if (status === 'live') {
            whereClause += ` AND nopd.link_status = 'Live'`;
        } else if (status === 'removed') {
            whereClause += ` AND nopd.link_status NOT IN ('Live', 'Pending Check') AND nopd.link_status IS NOT NULL`;
        }

        const statsQuery = `
            SELECT
                COUNT(*) as total_completed,
                COUNT(CASE WHEN nopd.link_status = 'Live' THEN 1 END) as live_count,
                COUNT(CASE WHEN nopd.link_status NOT IN ('Live', 'Pending Check') AND nopd.link_status IS NOT NULL THEN 1 END) as issue_count
            FROM new_order_process_details nopd
            JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
            JOIN new_orders no ON nop.new_order_id = no.id
            JOIN client_orders co ON co.linked_new_order_id = no.id
            ${whereClause}
        `;
        const statsResult = await query(statsQuery, params);
        const stats = statsResult.rows[0];

        const dataQuery = `
            SELECT
                nopd.id as detail_id,
                no.client_name,
                no.client_website,
                nopd.url as target_url,
                nopd.anchor as anchor_text,
                nopd.submit_url as blogger_link,
                nopd.link_status,
                nopd.link_check_result,
                nopd.last_checked_at,
                nopd.updated_at as completed_date
            FROM new_order_process_details nopd
            JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
            JOIN new_orders no ON nop.new_order_id = no.id
            JOIN client_orders co ON co.linked_new_order_id = no.id
            ${whereClause}
            ORDER BY no.client_name, no.client_website, nopd.updated_at DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;
        const dataParams = [...params, limit, offset];
        const dataResult = await query(dataQuery, dataParams);

        // Group by client_name + client_website
        const groupedData = [];
        let currentGroup = null;

        dataResult.rows.forEach(row => {
            const groupKey = `${row.client_name}|${row.client_website}`;
            if (!currentGroup || currentGroup.groupKey !== groupKey) {
                if (currentGroup) groupedData.push(currentGroup);
                currentGroup = {
                    groupKey,
                    client_name: row.client_name,
                    client_website: row.client_website,
                    link_count: 0,
                    links: []
                };
            }
            currentGroup.link_count++;
            currentGroup.links.push({
                detail_id: row.detail_id,
                target_url: row.target_url,
                anchor_text: row.anchor_text,
                blogger_link: row.blogger_link,
                link_status: row.link_status,
                link_check_result: row.link_check_result,
                last_checked_at: row.last_checked_at
            });
        });
        if (currentGroup) groupedData.push(currentGroup);

        const countQuery = `
            SELECT COUNT(*) 
            FROM new_order_process_details nopd
            JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
            JOIN new_orders no ON nop.new_order_id = no.id
            JOIN client_orders co ON co.linked_new_order_id = no.id
            ${whereClause}
        `;
        const countResult = await query(countQuery, params);
        const totalItems = parseInt(countResult.rows[0].count);

        res.json({
            stats: {
                completed: parseInt(stats.total_completed) || 0,
                live: parseInt(stats.live_count) || 0,
                removed: parseInt(stats.issue_count) || 0
            },
            data: groupedData,
            pagination: {
                total: totalItems,
                page: parseInt(page),
                pages: Math.ceil(totalItems / limit)
            }
        });
    } catch (error) {
        logger.error('Client:GetCompletedLinks', error);
        next(error);
    }
};

const checkLinkStatus = async (req, res, next) => {
    try {
        const { detailId, bloggerLink, clientWebsite, anchorText } = req.body;
        const clientId = req.user.id;

        if (!bloggerLink || !clientWebsite) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Verify ownership
        const ownershipCheck = await query(`
            SELECT 1 FROM new_order_process_details nopd
            JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
            JOIN new_orders no ON nop.new_order_id = no.id
            JOIN client_orders co ON co.linked_new_order_id = no.id
            WHERE nopd.id = $1 AND co.client_user_id = $2
        `, [detailId, clientId]);

        if (ownershipCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Unauthorized to check this link' });
        }

        let linkStatus = 'Not Found';
        let linkClassification = 'Link Removed';
        let checkResult = '';

        try {
            const response = await axios.get(bloggerLink, {
                timeout: 20000,
                maxRedirects: 5,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5'
                },
                validateStatus: (status) => status >= 200 && status < 500
            });

            if (response.status === 404) {
                linkStatus = 'Not Found';
                checkResult = 'Page Not Found (404)';
            } else if (response.status < 200 || response.status >= 300) {
                linkStatus = 'Issue';
                checkResult = `Issue! Status ${response.status}`;
            } else {
                const $ = cheerio.load(response.data);
                let cleanClientWebsite = clientWebsite.toLowerCase();
                if (cleanClientWebsite.endsWith('/')) {
                    cleanClientWebsite = cleanClientWebsite.slice(0, -1);
                }
                const clientDomain = cleanClientWebsite.replace(/^https?:\/\//, '');

                let foundAnyLink = false;
                let foundMatchingAnchor = false;
                let bestMismatchText = null;
                let finalRel = 'Dofollow';

                $('a').each((i, el) => {
                    const link = $(el);
                    let href = link.attr('href');
                    let text = link.text().trim();
                    const rel = link.attr('rel') || '';

                    if (!href) return;

                    let cleanHref = href.toLowerCase();
                    if (cleanHref.endsWith('/')) {
                        cleanHref = cleanHref.slice(0, -1);
                    }
                    const hrefDomain = cleanHref.replace(/^https?:\/\//, '');

                    if (hrefDomain.includes(clientDomain) || cleanHref.includes(clientDomain)) {
                        foundAnyLink = true;

                        if (!anchorText || anchorText.trim() === '') {
                            foundMatchingAnchor = true;
                            finalRel = rel;
                            return false; 
                        } else {
                            let expected = anchorText.replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
                            let actual = text.replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
                            
                            if (actual === '') {
                                const imgAlt = link.find('img').attr('alt');
                                if (imgAlt) actual = imgAlt.replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
                            }

                            if (actual !== '' && (actual.includes(expected) || expected.includes(actual))) {
                                foundMatchingAnchor = true;
                                finalRel = rel;
                                return false; 
                            } else if (actual !== '') {
                                if (!bestMismatchText) bestMismatchText = actual;
                            }
                        }
                    }
                });

                if (foundMatchingAnchor) {
                    linkStatus = 'Live';
                    linkClassification = finalRel.includes('nofollow') ? 'Nofollow' : 'Dofollow';
                    checkResult = `Live - ${linkClassification}`;
                } else if (foundAnyLink) {
                    linkStatus = 'Issue';
                    linkClassification = 'Mismatch';
                    checkResult = `Issue! Anchor Text (Expected: "${anchorText}", Found: "${bestMismatchText || 'Empty/Image Link'}")`;
                } else {
                    linkStatus = 'Not Found';
                    checkResult = `Link to ${clientDomain} not found on page`;
                }
            }
        } catch (error) {
            linkStatus = 'Error';
            checkResult = error.code === 'ECONNREFUSED' ? 'Connection Refused' :
                error.code === 'ETIMEDOUT' ? 'Request Timeout' :
                    error.code === 'ENOTFOUND' ? 'Domain Not Found' :
                        error.message || 'Scraping Error';
        }

        const updateResult = await query(`
            UPDATE new_order_process_details
            SET link_status = $1, link_check_result = $2, last_checked_at = NOW()
            WHERE id = $3
            RETURNING link_status, link_check_result, last_checked_at
        `, [linkStatus, checkResult, detailId]);

        res.json({
            status: linkStatus,
            result: checkResult,
            updated: updateResult.rows[0]
        });

    } catch (error) {
        logger.error('Client:CheckLinkStatus', error);
        next(error);
    }
};

/**
 * @route   GET /api/client/transactions
 * @desc    Get client transaction history (wallet topups, refunds, order payments)
 * @access  Private (Client)
 */
const getTransactions = async (req, res, next) => {
    try {
        const clientId = req.user.id;
        const { page = 1, limit = 20, type } = req.query;
        const offset = (page - 1) * limit;

        // 1. Get wallet ID and current balance
        const walletResult = await query(
            'SELECT id, COALESCE(balance, 0) as balance FROM wallets WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
            [clientId]
        );

        if (walletResult.rows.length === 0) {
            return res.json({
                balance: 0,
                transactions: [],
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: 0,
                    totalPages: 0
                }
            });
        }

        const walletId = walletResult.rows[0].id;
        const balance = parseFloat(walletResult.rows[0].balance);

        // 2. Build filter conditions
        let whereClause = 'WHERE wh.wallet_id = $1';
        const params = [walletId];
        let paramIndex = 2;

        if (type && type !== 'All') {
            if (type === 'Credit' || type === 'Debit') {
                whereClause += ` AND wh.type = $${paramIndex}`;
                params.push(type);
                paramIndex++;
            } else if (type === 'Topup') {
                whereClause += ` AND wh.type = 'Credit' AND wh.order_detail_id IS NULL`;
            } else if (type === 'Refund') {
                whereClause += ` AND wh.type = 'Credit' AND wh.order_detail_id IS NOT NULL`;
            }
        }

        // 3. Count total transactions
        const countResult = await query(
            `SELECT COUNT(*) as total FROM wallet_histories wh ${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].total || 0);

        // 4. Fetch transactions with details
        const transactionsResult = await query(
            `SELECT wh.id, wh.wallet_id, wh.order_detail_id, wh.type, wh.price, wh.remarks, wh.created_at,
                    cod.client_order_id, co.order_type
             FROM wallet_histories wh
             LEFT JOIN client_order_details cod ON wh.order_detail_id = cod.id
             LEFT JOIN client_orders co ON cod.client_order_id = co.id
             ${whereClause}
             ORDER BY wh.created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            [...params, parseInt(limit), parseInt(offset)]
        );

        res.json({
            balance,
            transactions: transactionsResult.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        logger.error('Client:GetTransactions', error);
        next(error);
    }
};

module.exports = {
    getDashboard,
    getWallet,
    createPaymentOrder,
    verifyPayment,
    getSites,
    createOrder,
    getOrders,
    getOrderDetails,
    getCompletedLinks,
    checkLinkStatus,
    getTransactions
};
