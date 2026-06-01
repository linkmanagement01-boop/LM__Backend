const Task = require('../models/Task');
const Transaction = require('../models/Transaction');
const { isTransitionAllowed } = require('../utils/statusTransitions');
const { addCreditToBloggerWallet, processWithdrawalApproval } = require('../utils/walletService');
const { query } = require('../config/database');
const { sendOrderAssignedEmail } = require('../utils/emailService');

/**
 * Manager Controller
 * The workflow traffic controller - handles all approvals
 */

// ==================== DASHBOARD ====================

/**
 * @route   GET /api/manager/dashboard
 * @desc    Get dashboard statistics matching production layout
 * @access  Manager only
 * 
 * Shows ONLY truly pending items from active workflow:
 * - Pending Bloggers: status 5 with submit_url (blogger submitted, awaiting manager approval)
 * - Pending Teams: status 2 (team submitted to manager)
 * - Pending Writers: status 4 (writer submitted content)
 * - Status 8 = Credited (completed, don't show)
 */
const getDashboardStats = async (req, res, next) => {
    try {
        const managerId = req.user.id;

        // Pending Approvals for Bloggers: status 7 = blogger submitted URL, awaiting manager verification
        // CRITICAL: We DO NOT check nop.status = 7 here. Bulk direct pushes share a process ID, so
        // if one blogger submits, their nopd.status is 7. We count all individual detail submissions individually.
        const pendingBloggersResult = await query(
            `SELECT COUNT(*) as count 
             FROM new_order_process_details nopd
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             JOIN new_orders o ON nop.new_order_id = o.id
             WHERE nopd.status = 7 
               AND nopd.submit_url IS NOT NULL
               AND o.new_order_status < 5
               AND o.order_id NOT LIKE 'CLT-%'`
        );

        // Pending Approvals Teams: BOTH order and process status must be 2
        // Use LATERAL JOIN to get only the latest process record per order
        const pendingTeamsResult = await query(
            `SELECT COUNT(*) as count 
             FROM new_orders o
             LEFT JOIN LATERAL (
                 SELECT status, id 
                 FROM new_order_processes 
                 WHERE new_order_id = o.id 
                 ORDER BY id DESC LIMIT 1
             ) nop ON true
             WHERE o.new_order_status = 2 
               AND nop.status = 2
               AND o.manager_id = $1
               AND o.order_id NOT LIKE 'CLT-%'`,
            [managerId]
        );

        // Pending Approvals Writers: BOTH order and process status must be 4
        // Use LATERAL JOIN to get only the latest process record per order
        const pendingWritersResult = await query(
            `SELECT COUNT(*) as count 
             FROM new_orders o
             LEFT JOIN LATERAL (
                 SELECT status, id 
                 FROM new_order_processes 
                 WHERE new_order_id = o.id 
                 ORDER BY id DESC LIMIT 1
             ) nop ON true
             WHERE o.new_order_status = 4 
               AND nop.status = 4
               AND o.manager_id = $1
               AND o.order_id NOT LIKE 'CLT-%'`,
            [managerId]
        );

        // Rejected Orders Bloggers (status 11 = Rejected OR has reject_reason)
        // Matches the logic in getRejectedOrders to show exact true count of all rejections
        const rejectedOrdersResult = await query(
            `SELECT COUNT(*) as count FROM new_order_process_details nopd
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             JOIN new_orders o ON nop.new_order_id = o.id
             WHERE (nopd.status = 11 OR (nopd.reject_reason IS NOT NULL AND TRIM(nopd.reject_reason) != ''))
               AND o.order_id NOT LIKE 'CLT-%'`
        );

        // Threads count
        const threadsResult = await query(
            `SELECT COUNT(*) as count FROM threads`
        );

        // Today's Pending Approvals For Bloggers: Apply same filters as main count
        const pendingBloggerApprovalsResult = await query(
            `SELECT 
                o.order_id,
                u.name as vendor_name,
                u.email as vendor_email,
                ns.root_domain as new_site,
                'Pending' as status,
                nopd.id as detail_id,
                nopd.submit_url,
                nopd.created_at
             FROM new_order_process_details nopd
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             JOIN new_orders o ON nop.new_order_id = o.id
             LEFT JOIN users u ON nopd.vendor_id = u.id
             LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
             WHERE nopd.status = 7
               AND nopd.submit_url IS NOT NULL
               AND o.new_order_status < 5
               AND o.order_id NOT LIKE 'CLT-%'
             ORDER BY nopd.created_at DESC
             LIMIT 50`
        );

        res.json({
            stats: {
                pending_bloggers: parseInt(pendingBloggersResult.rows[0]?.count || 0),
                pending_teams: parseInt(pendingTeamsResult.rows[0]?.count || 0),
                pending_writers: parseInt(pendingWritersResult.rows[0]?.count || 0),
                rejected_orders: parseInt(rejectedOrdersResult.rows[0]?.count || 0),
                threads: parseInt(threadsResult.rows[0]?.count || 0)
            },
            pending_blogger_approvals: pendingBloggerApprovalsResult.rows
        });
    } catch (error) {
        next(error);
    }
};

// ==================== TASK MANAGEMENT ====================

/**
 * @route   GET /api/manager/tasks
 * @desc    Get tasks for manager review
 * @access  Manager only
 */
const getTasks = async (req, res, next) => {
    try {
        const { current_status, status } = req.query;

        const filters = { exclude_client_orders: true };
        // Support both 'current_status' (used by frontend) and 'status' (legacy)
        if (current_status) filters.current_status = current_status;
        else if (status) filters.current_status = status;

        const tasks = await Task.findAll(filters);

        res.json({
            count: tasks.length,
            tasks
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/manager/orders
 * @desc    Get all orders from new_orders table with pagination
 * @access  Manager only
 */
const getOrders = async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        const { status, search, client_name, client_website, category, order_id, manager_id, ordered_at_from, ordered_at_to } = req.query;

        let whereClauses = [];
        let params = [];
        let paramIndex = 1;

        if (status) {
            whereClauses.push(`status_label ILIKE $${paramIndex}`);
            params.push(status);
            paramIndex++;
        }

        if (search) {
            whereClauses.push(`(order_id ILIKE $${paramIndex} OR client_name ILIKE $${paramIndex} OR manager_name ILIKE $${paramIndex} OR client_website ILIKE $${paramIndex})`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (client_name) {
            whereClauses.push(`client_name ILIKE $${paramIndex}`);
            params.push(`%${client_name}%`);
            paramIndex++;
        }

        if (client_website) {
            whereClauses.push(`client_website ILIKE $${paramIndex}`);
            params.push(`%${client_website}%`);
            paramIndex++;
        }

        if (category) {
            whereClauses.push(`category ILIKE $${paramIndex}`);
            params.push(`%${category}%`);
            paramIndex++;
        }

        if (order_id) {
            whereClauses.push(`order_id ILIKE $${paramIndex}`);
            params.push(`%${order_id}%`);
            paramIndex++;
        }

        if (manager_id) {
            if (manager_id === 'unassigned') {
                whereClauses.push(`manager_id IS NULL`);
            } else {
                whereClauses.push(`manager_id = $${paramIndex}`);
                params.push(parseInt(manager_id));
                paramIndex++;
            }
        }

        if (ordered_at_from) {
            whereClauses.push(`created_at >= $${paramIndex}`);
            params.push(new Date(ordered_at_from));
            paramIndex++;
        }

        if (ordered_at_to) {
            const endDate = new Date(ordered_at_to);
            endDate.setDate(endDate.getDate() + 1);
            whereClauses.push(`created_at < $${paramIndex}`);
            params.push(endDate);
            paramIndex++;
        }

        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // Get total count using CTE
        const countQuery = `
            WITH combined_orders AS (
                SELECT 
                    o.order_id::varchar,
                    o.client_name::varchar,
                    COALESCE(
                        NULLIF(o.client_website, ''),
                        (SELECT ns.root_domain FROM new_order_process_details nopd 
                         JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id 
                         JOIN new_sites ns ON nopd.new_site_id = ns.id 
                         WHERE nop.new_order_id = o.id LIMIT 1)
                    )::varchar as client_website,
                    o.category::text,
                    o.manager_id::integer,
                    m.name::varchar as manager_name,
                    CASE 
                        WHEN o.new_order_status = 1 THEN 'Pending'
                        WHEN o.new_order_status = 2 THEN 'In Progress'
                        WHEN o.new_order_status = 3 THEN 'With Writer'
                        WHEN o.new_order_status = 4 THEN 'With Blogger'
                        WHEN o.new_order_status = 5 THEN 'Completed'
                        WHEN o.new_order_status = 6 THEN 'Rejected'
                        ELSE 'Unknown'
                    END::varchar as status_label,
                    o.created_at
                FROM new_orders o
                LEFT JOIN users m ON o.manager_id = m.id

                UNION ALL

                SELECT 
                    ('CLT-PRV-' || co.id)::varchar as order_id,
                    u.name::varchar as client_name,
                    (SELECT ns.root_domain FROM client_order_details cod LEFT JOIN new_sites ns ON ns.id = cod.site_id WHERE cod.client_order_id = co.id LIMIT 1)::varchar as client_website,
                    co.category::text,
                    co.assigned_to::integer as manager_id,
                    am.name::varchar as manager_name,
                    CASE 
                        WHEN co.status = 'pending_review' THEN 'Pending'
                        WHEN co.status = 'rejected' THEN 'Rejected'
                        ELSE co.status
                    END::varchar as status_label,
                    co.created_at
                FROM client_orders co
                LEFT JOIN users u ON u.id = co.client_user_id
                LEFT JOIN users am ON am.id = co.assigned_to
                WHERE co.linked_new_order_id IS NULL
            )
            SELECT COUNT(*) as total FROM combined_orders ${whereSql}
        `;

        const countResult = await query(countQuery, params);
        const total = parseInt(countResult.rows[0]?.total || 0);

        // Fetch paginated combined orders
        const ordersQuery = `
            WITH combined_orders AS (
                SELECT 
                    ('M-' || o.id)::text as id,
                    o.order_id::varchar,
                    o.client_name::varchar,
                    COALESCE(
                        NULLIF(o.client_website, ''),
                        (SELECT ns.root_domain FROM new_order_process_details nopd 
                         JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id 
                         JOIN new_sites ns ON nopd.new_site_id = ns.id 
                         WHERE nop.new_order_id = o.id LIMIT 1)
                    )::varchar as client_website,
                    o.no_of_links::varchar,
                    o.order_type::varchar,
                    o.order_package::varchar,
                    o.message::text,
                    o.category::text,
                    o.new_order_status::integer as status,
                    CASE 
                        WHEN o.new_order_status = 1 THEN 'Pending'
                        WHEN o.new_order_status = 2 THEN 'In Progress'
                        WHEN o.new_order_status = 3 THEN 'With Writer'
                        WHEN o.new_order_status = 4 THEN 'With Blogger'
                        WHEN o.new_order_status = 5 THEN 'Completed'
                        WHEN o.new_order_status = 6 THEN 'Rejected'
                        ELSE 'Unknown'
                    END::varchar as status_label,
                    o.completed_tasks::double precision,
                    o.team_id::integer,
                    o.manager_id::integer,
                    m.name::varchar as manager_name,
                    m.email::varchar as manager_email,
                    o.created_at,
                    o.updated_at,
                    false as is_unapproved_client_order
                FROM new_orders o
                LEFT JOIN users m ON o.manager_id = m.id

                UNION ALL

                SELECT 
                    ('C-' || co.id)::text as id,
                    ('CLT-PRV-' || co.id)::varchar as order_id,
                    u.name::varchar as client_name,
                    (SELECT ns.root_domain FROM client_order_details cod LEFT JOIN new_sites ns ON ns.id = cod.site_id WHERE cod.client_order_id = co.id LIMIT 1)::varchar as client_website,
                    co.no_of_links::varchar,
                    co.order_type::varchar,
                    co.order_package::varchar,
                    co.notes::text as message,
                    co.category::text,
                    1::integer as status,
                    CASE 
                        WHEN co.status = 'pending_review' THEN 'Pending'
                        WHEN co.status = 'rejected' THEN 'Rejected'
                        ELSE co.status
                    END::varchar as status_label,
                    0::double precision as completed_tasks,
                    0::integer as team_id,
                    co.assigned_to::integer as manager_id,
                    am.name::varchar as manager_name,
                    am.email::varchar as manager_email,
                    co.created_at,
                    co.updated_at,
                    true as is_unapproved_client_order
                FROM client_orders co
                LEFT JOIN users u ON u.id = co.client_user_id
                LEFT JOIN users am ON am.id = co.assigned_to
                WHERE co.linked_new_order_id IS NULL
            )
            SELECT * FROM combined_orders
            ${whereSql}
            ORDER BY created_at DESC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;

        const ordersResult = await query(ordersQuery, [...params, limit, offset]);

        res.json({
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            count: ordersResult.rows.length,
            orders: ordersResult.rows
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/manager/orders/:id
 * @desc    Update an existing order
 * @access  Manager only
 */
const updateOrder = async (req, res, next) => {
    try {
        const { id } = req.params;
        const {
            client_name, client_website, order_type, no_of_links, tat_deadline,
            niche_price, gp_price, notes, message, assigned_team_id
        } = req.body;

        // Check task exists
        const task = await Task.findById(id);
        if (!task) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Order not found'
            });
        }

        // Build update query dynamically
        const updates = [];
        const values = [];
        let paramIndex = 1;

        if (client_name !== undefined) {
            updates.push(`client_name = $${paramIndex++}`);
            values.push(client_name);
        }
        if (client_website !== undefined) {
            updates.push(`client_website = $${paramIndex++}`);
            values.push(client_website);
        }
        if (order_type !== undefined) {
            updates.push(`order_type = $${paramIndex++}`);
            values.push(order_type);
        }
        if (no_of_links !== undefined) {
            updates.push(`no_of_links = $${paramIndex++}`);
            values.push(no_of_links);
        }
        if (tat_deadline !== undefined) {
            updates.push(`tat_deadline = $${paramIndex++}`);
            values.push(tat_deadline);
        }
        if (niche_price !== undefined) {
            updates.push(`niche_price = $${paramIndex++}`);
            values.push(niche_price);
        }
        if (gp_price !== undefined) {
            updates.push(`gp_price = $${paramIndex++}`);
            values.push(gp_price);
        }
        if (notes !== undefined) {
            updates.push(`notes = $${paramIndex++}`);
            values.push(notes);
        }
        if (message !== undefined) {
            updates.push(`message = $${paramIndex++}`);
            values.push(message);
        }
        if (assigned_team_id !== undefined) {
            updates.push(`assigned_team_id = $${paramIndex++}`);
            values.push(assigned_team_id);
        }

        if (updates.length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'No fields to update'
            });
        }

        // Add id as the last parameter
        values.push(id);

        // Direct update to new_orders table
        const updateQuery = `
            UPDATE new_orders 
            SET ${updates.join(', ')}, updated_at = NOW()
            WHERE id = $${paramIndex}
            RETURNING *
        `;

        const result = await query(updateQuery, values);

        res.json({
            message: 'Order updated successfully',
            order: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/manager/pending-from-bloggers
 * @desc    Get orders pending from bloggers (submitted URLs awaiting verification)
 * @access  Manager only
 */
const getPendingFromBloggers = async (req, res, next) => {
    try {
        // Get all orders where blogger has submitted URL (status = 7)
        // These are pending manager verification
        const result = await query(
            `SELECT 
                nopd.id as detail_id,
                nopd.new_order_process_id as process_id,
                nopd.new_site_id as site_id,
                nopd.vendor_id,
                nopd.status as detail_status,
                nopd.submit_url,
                nopd.anchor,
                nopd.url as target_url,
                COALESCE(nopd.ourl, nopd.doc_urls) as post_url,
                nopd.type as option,
                nopd.insert_after,
                nopd.statement,
                nopd.note as notes,
                nopd.upfront_payment,
                nopd.link_status,
                nopd.link_check_result,
                nopd.created_at,
                ns.root_domain,
                ns.da,
                ns.dr,
                ns.gp_price,
                ns.niche_edit_price as niche_price,
                ns.fc_gp,
                ns.fc_ne,
                v.name as vendor_name,
                v.email as vendor_email,
                nop.new_order_id as db_order_id,
                no.order_id as manual_order_id,
                no.client_name,
                no.order_type,
                no.category,
                no.fc
             FROM new_order_process_details nopd
             JOIN new_sites ns ON nopd.new_site_id = ns.id
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             JOIN new_orders no ON nop.new_order_id = no.id
             LEFT JOIN users v ON nopd.vendor_id = v.id
             WHERE nopd.status = 7 
               AND nopd.submit_url IS NOT NULL
               AND no.new_order_status < 5
               AND no.order_id NOT LIKE 'CLT-%'
             ORDER BY nopd.updated_at DESC`
        );

        // Map to frontend format matching the screenshot and the frontend component
        const orders = result.rows.map(row => ({
            // Core Identity
            id: row.detail_id,
            process_id: row.process_id,
            order_id: row.manual_order_id || `#${row.db_order_id}`,
            order_type: row.order_type,
            client_name: row.client_name,

            // Vendor/Blogger info (frontend expects blogger_name, blogger_email)
            vendor_id: row.vendor_id,
            vendor_name: row.vendor_name,
            blogger_name: row.vendor_name,
            vendor_email: row.vendor_email,
            blogger_email: row.vendor_email,

            // Site info (frontend expects website_url)
            root_domain: row.root_domain,
            new_site: row.root_domain,
            website_url: row.root_domain,
            da: row.da,
            dr: row.dr,

            // Order details
            anchor: row.anchor,
            target_url: row.target_url,
            post_url: row.post_url,
            option: row.option,
            insert_after: row.insert_after,
            statement: row.statement,
            notes: row.notes,

            // Submitted URL from blogger (frontend expects live_published_url)
            submitted_url: row.submit_url,
            submit_url: row.submit_url,
            live_published_url: row.submit_url,

            // Status (frontend expects current_status)
            status: 'Pending Verification',
            detail_status: row.detail_status,
            current_status: 'PENDING_MANAGER_APPROVAL',

            // Link verification status
            link_status: row.link_status || 'Pending',
            link_check_result: row.link_check_result || '',

            updated_at: row.created_at,
            created_at: row.created_at
        }));

        res.json({
            count: orders.length,
            orders
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/manager/rejected-orders
 * @desc    Get rejected blogger orders from new_order_process_details with pagination
 * @access  Manager only
 */
const getRejectedOrders = async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        // Only use strict status codes — the reject_reason fallback was causing
        // inflated counts by including records (status 7/8) that were later resubmitted
        // but still had a leftover reject_reason from a previous rejection cycle.
        // NOTE: User requested ALL rejected records (approx 1269), even those resubmitted.
        const countResult = await query(
            `SELECT COUNT(*) as total FROM new_order_process_details nopd
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             JOIN new_orders o ON nop.new_order_id = o.id
             WHERE (nopd.status = 11 OR (nopd.reject_reason IS NOT NULL AND TRIM(nopd.reject_reason) != ''))
               AND o.order_id NOT LIKE 'CLT-%'`
        );
        const total = parseInt(countResult.rows[0]?.total || 0);

        // Get rejected orders with vendor and site info
        const ordersResult = await query(
            `SELECT 
                nopd.id,
                o.order_id,
                o.client_name,
                o.order_type,
                u.name as blogger_name,
                u.email as blogger_email,
                ns.root_domain as website_url,
                nopd.reject_reason as rejection_reason,
                'Rejected' as status_label,
                nopd.status,
                nopd.created_at,
                nopd.updated_at
             FROM new_order_process_details nopd
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             JOIN new_orders o ON nop.new_order_id = o.id
             LEFT JOIN users u ON nopd.vendor_id = u.id
             LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
             WHERE (nopd.status = 11 OR (nopd.reject_reason IS NOT NULL AND TRIM(nopd.reject_reason) != ''))
               AND o.order_id NOT LIKE 'CLT-%'
             ORDER BY nopd.updated_at DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        res.json({
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            count: ordersResult.rows.length,
            orders: ordersResult.rows
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/manager/rejected-orders/writers
 * @desc    Get orders rejected by writers (with reasons)
 * @access  Manager only
 */
const getRejectedWriterOrders = async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        // Count writer-rejected orders
        const countResult = await query(
            `SELECT COUNT(*) as total FROM new_order_processes nop
             JOIN new_orders o ON nop.new_order_id = o.id
             WHERE nop.status = 11 AND nop.writer_id IS NOT NULL
               AND o.order_id NOT LIKE 'CLT-%'`
        );
        const total = parseInt(countResult.rows[0]?.total || 0);

        // Get rejected orders with writer info
        const ordersResult = await query(
            `SELECT 
                nop.id as process_id,
                o.id as order_id,
                o.order_id as manual_order_id,
                o.client_name,
                o.order_type,
                o.category,
                w.name as writer_name,
                w.email as writer_email,
                nop.note as reject_reason,
                nop.status,
                nop.created_at,
                nop.updated_at
             FROM new_order_processes nop
             JOIN new_orders o ON nop.new_order_id = o.id
             LEFT JOIN users w ON nop.writer_id = w.id
             WHERE nop.status = 11 AND nop.writer_id IS NOT NULL
               AND o.order_id NOT LIKE 'CLT-%'
             ORDER BY nop.updated_at DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        res.json({
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            count: ordersResult.rows.length,
            orders: ordersResult.rows
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/manager/orders/:id/details
 * @desc    Get complete order workflow details including processes and blogger assignments
 * @access  Manager only
 */
const getOrderDetails = async (req, res, next) => {
    try {
        let { id } = req.params;
        let isClientOrder = false;
        let numericId = id;

        if (typeof id === 'string') {
            if (id.startsWith('C-')) {
                isClientOrder = true;
                numericId = parseInt(id.replace('C-', ''));
            } else if (id.startsWith('M-')) {
                isClientOrder = false;
                numericId = parseInt(id.replace('M-', ''));
            } else {
                numericId = parseInt(id);
            }
        }

        if (isNaN(numericId)) {
            return res.status(400).json({ error: 'Invalid order ID' });
        }

        if (isClientOrder) {
            const clientOrderRes = await query(
                `SELECT 
                    co.id,
                    u.name as client_name,
                    (SELECT ns.root_domain FROM client_order_details cod LEFT JOIN new_sites ns ON ns.id = cod.site_id WHERE cod.client_order_id = co.id LIMIT 1) as client_website,
                    co.no_of_links,
                    co.order_type,
                    co.order_package,
                    co.notes as message,
                    co.category,
                    co.created_at,
                    co.updated_at,
                    am.name as manager_name,
                    am.email as manager_email
                 FROM client_orders co
                 LEFT JOIN users u ON u.id = co.client_user_id
                 LEFT JOIN users am ON am.id = co.assigned_to
                 WHERE co.id = $1`,
                [numericId]
            );

            if (clientOrderRes.rows.length === 0) {
                return res.status(404).json({ error: 'Order not found' });
            }

            const clientOrder = clientOrderRes.rows[0];
            return res.json({
                order: {
                    id: 'C-' + clientOrder.id,
                    order_id: 'CLT-PRV-' + clientOrder.id,
                    client_name: clientOrder.client_name,
                    client_website: clientOrder.client_website,
                    no_of_links: clientOrder.no_of_links,
                    order_type: clientOrder.order_type,
                    order_package: clientOrder.order_package,
                    message: clientOrder.message,
                    category: clientOrder.category,
                    new_order_status: 1,
                    current_workflow_status: 'Pending',
                    created_at: clientOrder.created_at,
                    updated_at: clientOrder.updated_at,
                    manager_name: clientOrder.manager_name,
                    manager_email: clientOrder.manager_email
                },
                processes: []
            });
        }

        // Get order basic info
        const orderResult = await query(
            `SELECT 
                o.id,
                o.order_id,
                o.client_name,
                o.client_website,
                o.no_of_links,
                o.order_type,
                o.order_package,
                o.message,
                o.category,
                o.fc,
                o.new_order_status,
                o.created_at,
                o.updated_at,
                m.name as manager_name,
                m.email as manager_email,
                CASE 
                    WHEN o.new_order_status = 1 THEN 'Pending'
                    WHEN o.new_order_status = 2 THEN 'In Progress'
                    WHEN o.new_order_status = 3 THEN 'With Writer'
                    WHEN o.new_order_status = 4 THEN 'With Blogger'
                    WHEN o.new_order_status = 5 THEN 'Completed'
                    WHEN o.new_order_status = 6 THEN 'Rejected'
                    ELSE 'Unknown'
                END as current_workflow_status
             FROM new_orders o
             LEFT JOIN users m ON o.manager_id = m.id
             WHERE o.id = $1`,
            [numericId]
        );

        if (orderResult.rows.length === 0) {
            // Fallback: Check if it exists in client_orders
            const checkClientRes = await query('SELECT id FROM client_orders WHERE id = $1', [numericId]);
            if (checkClientRes.rows.length > 0) {
                req.params.id = 'C-' + numericId;
                return getOrderDetails(req, res, next);
            }
            return res.status(404).json({ error: 'Order not found' });
        }

        const order = orderResult.rows[0];

        // Get ALL process records for this order (not just the latest)
        // This allows us to aggregate team/writer info across the full workflow history
        const allProcessesResult = await query(
            `SELECT 
                nop.id,
                nop.new_order_id,
                nop.team_id,
                nop.writer_id,
                nop.manager_id,
                nop.note,
                nop.doc_urls,
                nop.upload_doc_file,
                nop.status,
                nop.insert_after,
                nop.statement,
                nop.created_at,
                nop.updated_at,
                t.name as team_name,
                t.email as team_email,
                w.name as writer_name,
                w.email as writer_email
             FROM new_order_processes nop
             LEFT JOIN users t ON nop.team_id = t.id
             LEFT JOIN users w ON nop.writer_id = w.id
             WHERE nop.new_order_id = $1
             ORDER BY nop.created_at ASC`,
            [id]
        );

        const allProcesses = allProcessesResult.rows;
        // The latest process row (used for detail records and current status)
        const process = allProcesses.length > 0 ? allProcesses[allProcesses.length - 1] : null;

        // Aggregate team_id and writer_id from the ENTIRE history of process rows + order itself
        // This handles both imported orders (single row with all IDs) and normal orders (multiple rows where latest may have NULLs)
        const aggregatedTeamId = allProcesses.find(p => p.team_id)?.team_id || order.team_id || null;
        const aggregatedTeamName = allProcesses.find(p => p.team_id)?.team_name || null;
        const aggregatedTeamEmail = allProcesses.find(p => p.team_id)?.team_email || null;
        const teamProcess = allProcesses.find(p => p.team_id) || allProcesses[0];

        const writerProcess = [...allProcesses].reverse().find(p => p.writer_id);
        const aggregatedWriterId = writerProcess?.writer_id || null;
        const aggregatedWriterName = writerProcess?.writer_name || null;
        const aggregatedWriterEmail = writerProcess?.writer_email || null;

        // Find the process row where writer submitted (status 3 or has doc_urls/statement)
        const writerSubmittedProcess = allProcesses.find(p => p.status === 3) || writerProcess;

        // Get all detail records (blogger assignments)
        let processDetails = [];
        if (process) {
            const detailsResult = await query(
                `SELECT 
                    nopd.id,
                    nopd.new_order_process_id,
                    nopd.new_site_id,
                    nopd.url,
                    nopd.price,
                    nopd.anchor,
                    nopd.title,
                    nopd.doc_urls,
                    nopd.upload_doc_file,
                    nopd.insert_after,
                    nopd.statement,
                    nopd.note,
                    nopd.vendor_id,
                    nopd.status,
                    CASE 
                        WHEN nopd.status IS NULL THEN 'Pending'
                        WHEN nopd.status = 5 THEN 'Assigned'
                        WHEN nopd.status = 7 THEN 'Submitted'
                        WHEN nopd.status = 8 THEN 'Completed'
                        WHEN nopd.status = 10 THEN 'Archived'
                        WHEN nopd.status = 11 THEN 'Rejected'
                        ELSE 'Pending'
                    END as status_label,
                    nopd.submit_url,
                    nopd.ourl,
                    nopd.type,
                    nopd.new_note,
                    nopd.verify,
                    nopd.reject_reason,
                    nopd.created_at,
                    nopd.updated_at,
                    ns.root_domain as website,
                    ns.da,
                    ns.dr,
                    ns.niche_edit_price,
                    ns.gp_price,
                    ns.fc_gp,
                    ns.fc_ne,
                    b.name as blogger_name,
                    b.email as blogger_email
                 FROM new_order_process_details nopd
                 LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
                 LEFT JOIN users b ON nopd.vendor_id = b.id
                 WHERE nopd.new_order_process_id = $1
                 ORDER BY nopd.created_at ASC`,
                [process.id]
            );
            processDetails = detailsResult.rows;
        }

        // Helper to map ALL detail fields so frontend can pick per order_type
        const mapAllFields = (d) => ({
            id: d.id,
            website: d.website,
            da: d.da,
            dr: d.dr,
            price: (() => {
                const isFC = Number(order.fc) === 1;
                // If price is stored on the detail row, use it
                if (d.price && !isNaN(parseFloat(d.price)) && parseFloat(d.price) > 0) return parseFloat(d.price);
                const type = (order.order_type || '').toLowerCase();
                if (type.includes('niche') || type.includes('edit') || type.includes('insertion')) {
                    if (isFC && d.fc_ne && !isNaN(parseFloat(d.fc_ne)) && parseFloat(d.fc_ne) > 0) return parseFloat(d.fc_ne);
                    return parseFloat(d.niche_edit_price) || 0;
                }
                if (isFC && d.fc_gp && !isNaN(parseFloat(d.fc_gp)) && parseFloat(d.fc_gp) > 0) return parseFloat(d.fc_gp);
                return parseFloat(d.gp_price) || 0;
            })(),
            anchor: d.anchor,
            target_url: d.url,
            post_url: d.ourl,
            title: d.title,
            doc_urls: d.doc_urls,
            upload_doc_file: d.upload_doc_file,
            insert_after: d.insert_after,
            statement: d.statement,
            type: d.type,
            note: d.note,
            new_note: d.new_note,
            verify: d.verify,
            reject_reason: d.reject_reason,
            blogger_name: d.blogger_name,
            blogger_email: d.blogger_email,
            vendor_id: d.vendor_id,
            status: d.status,
            status_label: d.status_label,
            submit_url: d.submit_url,
            created_at: d.created_at,
            updated_at: d.updated_at
        });

        // Reconstruct workflow steps using AGGREGATED data from all process rows
        const reconstructedProcesses = [];

        // Step 1: Team Assignment (status=1)
        // Use aggregated team info — works for both imported (single row) and normal (multi-row) orders
        if (aggregatedTeamId) {
            reconstructedProcesses.push({
                id: teamProcess?.id || process?.id,
                status: 1,
                status_label: 'Team Assigned',
                team_id: aggregatedTeamId,
                team_name: aggregatedTeamName,
                team_email: aggregatedTeamEmail,
                created_at: teamProcess?.created_at || process?.created_at,
                blogger_assignments: processDetails.map(mapAllFields)
            });
        }

        // Step 2: Writer Assignment (status=2)
        // Use aggregated writer info from any historical process row
        if (aggregatedWriterId) {
            reconstructedProcesses.push({
                id: writerProcess?.id || process?.id,
                status: 2,
                status_label: 'Writer Assigned',
                writer_id: aggregatedWriterId,
                writer_name: aggregatedWriterName,
                writer_email: aggregatedWriterEmail,
                created_at: writerProcess?.created_at || process?.created_at,
                blogger_assignments: processDetails.map(mapAllFields)
            });
        }

        // Step 3: Writer Submitted (status=3)
        const writerSubmitted = processDetails.some(d => d.doc_urls || d.insert_after || d.statement || d.type);
        if (aggregatedWriterId && writerSubmitted) {
            reconstructedProcesses.push({
                id: writerSubmittedProcess?.id || process?.id,
                status: 3,
                status_label: 'Writer Submitted',
                writer_name: aggregatedWriterName,
                writer_email: aggregatedWriterEmail,
                created_at: writerSubmittedProcess?.updated_at || writerSubmittedProcess?.created_at || process?.updated_at || process?.created_at,
                blogger_assignments: processDetails.map(mapAllFields)
            });
        }

        // Step 4/5: Pushed to Blogger (status=5 to match frontend)
        const hasBloggerAssignments = processDetails.some(d => d.vendor_id);
        if (hasBloggerAssignments) {
            reconstructedProcesses.push({
                id: process.id,
                status: 5,
                status_label: 'Blogger Pushed',
                created_at: process.updated_at || process.created_at,
                blogger_assignments: processDetails.map(mapAllFields)
            });
        }

        // Calculate counts
        const completedCount = processDetails.filter(d => d.status === 8).length;
        const pendingCount = processDetails.filter(d => !d.submit_url && d.status !== 8 && d.status !== 11).length;
        const rejectedCount = processDetails.filter(d => d.status === 11).length;
        const submittedCount = processDetails.filter(d => d.submit_url).length;

        let currentStatus = 'Not Started';
        if (completedCount === processDetails.length && processDetails.length > 0) {
            currentStatus = 'Completed';
        } else if (hasBloggerAssignments) {
            currentStatus = 'Blogger Pushed';
        } else if (writerSubmitted) {
            currentStatus = 'Writer Submitted';
        } else if (aggregatedWriterId) {
            currentStatus = 'Writer Assigned';
        } else if (aggregatedTeamId) {
            currentStatus = 'Team Assigned';
        }

        res.json({
            order: {
                ...order,
                current_workflow_status: currentStatus,
                current_workflow_status_code: process?.status || 0
            },
            processes: reconstructedProcesses,
            total_blogger_assignments: processDetails.length,
            submitted_count: submittedCount,
            pending_count: pendingCount,
            rejected_count: rejectedCount,
            completed_count: completedCount
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/manager/orders
 * @desc    Create new order (WORKFLOW STEP 1: Manager pushes work to Team)
 * @access  Manager only
 */
const createOrder = async (req, res, next) => {
    try {
        const {
            client_name, order_type, no_of_links, tat_deadline,
            niche_price, gp_price, notes, assigned_team_id,
            // New Manager Panel fields
            manual_order_id, client_website, fc, order_package, category,
            post_url  // Post URL for Niche Edit orders
        } = req.body;

        // Validation
        if (!client_name) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Client name is required'
            });
        }

        // If team is assigned, verify they exist
        if (assigned_team_id) {
            const teamCheck = await query(
                "SELECT id, role FROM users WHERE id = $1 AND LOWER(role) = 'team'",
                [assigned_team_id]
            );

            if (teamCheck.rows.length === 0) {
                return res.status(400).json({
                    error: 'Validation Error',
                    message: 'Invalid team member ID or user is not a team member'
                });
            }
        }

        const task = await Task.create({
            created_by: req.user.id,
            manager_id: req.user.id,
            client_name,
            order_type: order_type || 'Guest Post',
            no_of_links: no_of_links || 1,
            tat_deadline: tat_deadline || null,
            niche_price: niche_price || 0,
            gp_price: gp_price || 0,
            notes,
            assigned_team_id,
            current_status: assigned_team_id ? 'PENDING_MANAGER_APPROVAL_1' : 'DRAFT',
            // New Manager Panel fields
            manual_order_id: manual_order_id || null,
            client_website: client_website || null,
            fc: fc || false,
            order_package: order_package || null,
            category: category || null,
            post_url: post_url || null  // Post URL for Niche Edit
        });

        // Emit real-time event for order creation
        const io = req.app.get('io');
        if (io) {
            const socketEvents = require('../utils/socketEvents');
            socketEvents.emitOrderCreated(io, task);
        }

        res.status(201).json({
            message: 'Order created successfully',
            task
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/manager/tasks/:id/assign-team
 * @desc    Assign task to Team member
 * @access  Manager only
 */
const assignToTeam = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { team_id } = req.body;

        // Validation
        if (!team_id) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Team member ID is required'
            });
        }

        // Get current task
        const task = await Task.findById(id);
        if (!task) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Task not found'
            });
        }

        // Verify team member exists
        const teamCheck = await query(
            "SELECT id, role FROM users WHERE id = $1 AND role = 'Team'",
            [team_id]
        );

        if (teamCheck.rows.length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Invalid team member ID or user is not a team member'
            });
        }

        // Assign to team
        const updatedTask = await Task.assignToTeam(id, team_id);

        res.json({
            message: 'Task assigned to team member successfully',
            task: updatedTask
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/manager/tasks/:id
 * @desc    Get specific task
 * @access  Manager only
 */
const getTaskById = async (req, res, next) => {
    try {
        const { id } = req.params;
        const task = await Task.findById(id);

        if (!task) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Task not found'
            });
        }

        res.json({ task });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/manager/tasks/:id/assign
 * @desc    Approval 1: Assign task to writer
 * @access  Manager only
 */
const assignToWriter = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { writer_id, instructions, website_details } = req.body;

        // Validation
        if (!writer_id) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Writer ID is required'
            });
        }

        // Get current task
        const task = await Task.findById(id);
        if (!task) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Task not found'
            });
        }

        // Validate status transition
        if (!isTransitionAllowed(task.current_status, 'ASSIGNED_TO_WRITER')) {
            return res.status(400).json({
                error: 'Invalid Transition',
                message: `Cannot assign to writer from status: ${task.current_status} `
            });
        }

        // Verify writer exists and has Writer role
        const writerCheck = await query(
            "SELECT id, role FROM users WHERE id = $1 AND LOWER(role) = 'writer'",
            [writer_id]
        );

        if (writerCheck.rows.length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Invalid writer ID or user is not a writer'
            });
        }

        // Update website details if provided - use new_order_process_details table
        if (website_details && Array.isArray(website_details) && website_details.length > 0) {
            console.log('Updating website details:', website_details);

            const updatePromises = website_details.map(detail => {
                const { id: detail_id, target_url, anchor_text, article_title, upfront_payment, paypal_id } = detail;
                console.log(`Updating detail ID ${detail_id}: `, { target_url, anchor_text, article_title, upfront_payment, paypal_id });

                return query(
                    `UPDATE new_order_process_details 
                     SET url = $1,
    anchor = $2,
    title = $3,
    upfront_payment = $4,
    paypal_email = $5,
    updated_at = CURRENT_TIMESTAMP
                     WHERE id = $6`,
                    [target_url, anchor_text, article_title, upfront_payment ? 1 : 0, paypal_id || null, detail_id]
                );
            });

            await Promise.all(updatePromises);
        }

        // Assign to writer
        const updatedTask = await Task.assignToWriter(id, writer_id, instructions);

        res.json({
            message: 'Task assigned to writer successfully',
            task: updatedTask
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/manager/tasks/:id/approve-content
 * @desc    Approval 2: Approve content and assign to blogger
 * @access  Manager only
 */
const approveContent = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { blogger_id } = req.body;

        // Validation
        if (!blogger_id) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Blogger ID is required'
            });
        }

        // Get current task
        const task = await Task.findById(id);
        if (!task) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Task not found'
            });
        }

        // Validate status transition
        if (!isTransitionAllowed(task.current_status, 'ASSIGNED_TO_BLOGGER')) {
            return res.status(400).json({
                error: 'Invalid Transition',
                message: `Cannot assign to blogger from status: ${task.current_status} `
            });
        }

        // Verify blogger exists
        const bloggerCheck = await query(
            "SELECT id, role FROM users WHERE id = $1 AND role = 'Blogger'",
            [blogger_id]
        );

        if (bloggerCheck.rows.length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Invalid blogger ID or user is not a blogger'
            });
        }

        // Assign to blogger
        const updatedTask = await Task.assignToBlogger(id, blogger_id);

        // Create notification for blogger
        await query(
            `INSERT INTO notifications(user_id, title, message, type, related_task_id, action_url)
VALUES($1, $2, $3, $4, $5, $6)`,
            [
                blogger_id,
                'New Order Pushed',
                `Order #${id} has been assigned to you`,
                'order_pushed',
                id,
                '/blogger/orders'
            ]
        );

        res.json({
            message: 'Content approved and assigned to blogger',
            task: updatedTask
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/manager/tasks/:id/return-to-writer
 * @desc    Return content to writer for revisions
 * @access  Manager only
 */
const returnToWriter = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { notes } = req.body;

        const task = await Task.findById(id);
        if (!task) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Task not found'
            });
        }

        if (!isTransitionAllowed(task.current_status, 'ASSIGNED_TO_WRITER')) {
            return res.status(400).json({
                error: 'Invalid Transition',
                message: 'Cannot return to writer from current status'
            });
        }

        const updatedTask = await Task.updateStatus(id, 'ASSIGNED_TO_WRITER', { notes });

        res.json({
            message: 'Task returned to writer for revisions',
            task: updatedTask
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/manager/tasks/:id/finalize
 * @desc    Approval 3: Finalize task and credit blogger
 * @access  Manager only
 */
const finalizeTask = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Get current task
        const task = await Task.findById(id);
        if (!task) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Task not found'
            });
        }

        // Validate status
        if (task.current_status !== 'PENDING_FINAL_CHECK') {
            return res.status(400).json({
                error: 'Invalid Transition',
                message: 'Task is not ready for finalization'
            });
        }

        // Get order detail ID and payment amount from new_order_process_details
        // This links the wallet_history entry to the site for root_domain display
        const orderDetailResult = await query(
            `SELECT nopd.id as order_detail_id, nopd.price, nopd.vendor_id
             FROM new_order_process_details nopd
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             WHERE nop.new_order_id = $1 AND nopd.vendor_id = $2
             ORDER BY nopd.id DESC LIMIT 1`,
            [id, task.assigned_blogger_id]
        );

        let orderDetailId = null;
        let paymentAmount = 50.00; // Default

        if (orderDetailResult.rows.length > 0) {
            orderDetailId = orderDetailResult.rows[0].order_detail_id;
            paymentAmount = parseFloat(orderDetailResult.rows[0].price) || 50.00;
        } else {
            // Fallback: Get default payment from config
            const configResult = await query(
                "SELECT config_value FROM system_config WHERE config_key = 'default_post_payment'"
            );
            if (configResult.rows.length > 0) {
                paymentAmount = parseFloat(configResult.rows[0].config_value);
            }
        }

        // Credit blogger wallet with order detail linkage for root_domain in wallet history
        await addCreditToBloggerWallet(task.assigned_blogger_id, paymentAmount, orderDetailId);

        // Update order detail status to 8 (credited)
        if (orderDetailId) {
            await query(
                'UPDATE new_order_process_details SET status = 8, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
                [orderDetailId]
            );
        }

        // Get the process ID of this detail
        const processIdResult = await query(
            `SELECT nop.id as process_id FROM new_order_processes nop
             WHERE nop.new_order_id = $1
             ORDER BY nop.id DESC LIMIT 1`,
            [id]
        );

        let allLinksComplete = false;

        if (processIdResult.rows.length > 0) {
            const processId = processIdResult.rows[0].process_id;

            // Check if ALL sibling details are complete (status = 8)
            // Order should only be marked complete when ALL links are approved
            const pendingCheck = await query(
                `SELECT COUNT(*) as pending FROM new_order_process_details 
                 WHERE new_order_process_id = $1 AND status != 8`,
                [processId]
            );

            allLinksComplete = parseInt(pendingCheck.rows[0].pending) === 0;

            // Only update process and order status if ALL details are complete
            if (allLinksComplete) {
                await query(
                    `UPDATE new_order_processes SET status = 8, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                    [processId]
                );
                // Now update the order status to complete
                await Task.markAsCompleted(id, paymentAmount);
            }
        }

        res.json({
            message: allLinksComplete
                ? 'Order finalized! All links are complete.'
                : 'Link credited successfully. Order still has pending links.',
            task: await Task.findById(id),
            payment_credited: paymentAmount,
            all_links_complete: allLinksComplete
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/manager/tasks/:id/reject
 * @desc    Reject task
 * @access  Manager only
 */
const rejectTask = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { rejection_reason } = req.body;

        if (!rejection_reason) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Rejection reason is required'
            });
        }

        // AUTO-REFUND: Before marking as rejected, find if this order generated any wallet credits
        const creditsRes = await query(`
            SELECT wh.id as wh_id, wh.wallet_id, wh.price
            FROM wallet_histories wh
            JOIN new_order_process_details nopd ON wh.order_detail_id = nopd.id
            JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
            WHERE nop.new_order_id = $1 AND wh.type = 'credit'
        `, [id]);

        let refundInfo = null;
        if (creditsRes.rows.length > 0) {
            let totalRefunded = 0;
            const updatedWalletIds = new Set();
            
            for (const row of creditsRes.rows) {
                // Delete credit
                await query('DELETE FROM wallet_histories WHERE id = $1', [row.wh_id]);
                totalRefunded += parseFloat(row.price || 0);
                updatedWalletIds.add(row.wallet_id);
            }
            
            // Recalculate all affected wallets
            for (const wId of updatedWalletIds) {
                const creditSum = await query(`SELECT COALESCE(SUM(CAST(price AS NUMERIC)), 0) as total FROM wallet_histories WHERE wallet_id = $1 AND type = 'credit'`, [wId]);
                const debitSum = await query(`SELECT COALESCE(SUM(CAST(price AS NUMERIC)), 0) as total FROM wallet_histories WHERE wallet_id = $1 AND type = 'debit'`, [wId]);
                const trueBalance = parseFloat(creditSum.rows[0].total) - parseFloat(debitSum.rows[0].total);
                await query('UPDATE wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [trueBalance, wId]);
            }
            
            refundInfo = { refunded_amount: totalRefunded, credits_removed: creditsRes.rows.length };
            console.log(`💰 Auto-refund via rejectTask: Removed $${totalRefunded} total from wallets for new_order_id ${id}`);
        }

        // Now actually reject the task
        const updatedTask = await Task.reject(id, rejection_reason);

        res.json({
            message: refundInfo 
                ? `Task rejected and $${refundInfo.refunded_amount} refunded from blogger wallets`
                : 'Task rejected',
            task: updatedTask,
            refund: refundInfo
        });
    } catch (error) {
        next(error);
    }
};

// ==================== WITHDRAWAL MANAGEMENT ====================

/**
 * @route   GET /api/manager/withdrawals
 * @desc    Get all withdrawal requests
 * @access  Manager only
 */
const getWithdrawals = async (req, res, next) => {
    try {
        const { status } = req.query;

        const filters = {};
        if (status) filters.status = status;

        const withdrawals = await Transaction.findAll(filters);

        res.json({
            count: withdrawals.length,
            withdrawals
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/manager/withdrawals/:id/approve
 * @desc    Approve withdrawal request
 * @access  Manager only
 */
const approveWithdrawal = async (req, res, next) => {
    try {
        const { id } = req.params;

        const withdrawal = await processWithdrawalApproval(id, req.user.id);

        res.json({
            message: 'Withdrawal approved and processed',
            withdrawal
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/manager/withdrawals/:id/reject
 * @desc    Reject withdrawal request
 * @access  Manager only
 */
const rejectWithdrawal = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { rejection_reason } = req.body;

        if (!rejection_reason) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Rejection reason is required'
            });
        }

        const withdrawal = await Transaction.reject(id, req.user.id, rejection_reason);

        res.json({
            message: 'Withdrawal request rejected',
            withdrawal
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/manager/pending-from-teams
 * @desc    Get orders pending approval from Team members
 * @access  Manager only
 */
const getPendingFromTeams = async (req, res, next) => {
    try {
        const orders = await Task.findAll({
            manager_id: req.user.id,
            current_status: 'PENDING_MANAGER_APPROVAL_1',
            exclude_client_orders: true
        });

        res.json({
            count: orders.length,
            orders
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/manager/pending-from-writers
 * @desc    Get orders pending content approval from Writers
 * @access  Manager only
 */
const getPendingFromWriters = async (req, res, next) => {
    try {
        // Use database-level filtering with current_status to apply dual-status checking
        // Both SUBMITTED_TO_MANAGER and PENDING_MANAGER_APPROVAL_2 map to status 4
        const orders = await Task.findAll({
            manager_id: req.user.id,
            current_status: 'PENDING_MANAGER_APPROVAL_2',
            exclude_client_orders: true
        });

        res.json({
            count: orders.length,
            orders
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/manager/tasks/:id/approve-team
 * @desc    Approve team's website selection
 * @access  Manager only
 */
const approveTeamSubmission = async (req, res, next) => {
    try {
        const { id } = req.params;

        const task = await Task.findById(id);
        if (!task) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Task not found'
            });
        }

        // Move to next status - ready for writer assignment
        const updated = await Task.updateStatus(id, 'PENDING_MANAGER_APPROVAL_1', {});

        res.json({
            message: 'Team submission approved',
            task: updated
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/manager/tasks/:id/reject-team
 * @desc    Reject team's website selection
 * @access  Manager only
 */
const rejectTeamSubmission = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        const task = await Task.findById(id);
        if (!task) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Task not found'
            });
        }

        // Send back to DRAFT so team member sees it in their queue again
        // Also update process and order status to 1 (team working)
        const processResult = await query(
            `SELECT id FROM new_order_processes WHERE new_order_id = $1 ORDER BY id DESC LIMIT 1`,
            [id]
        );

        if (processResult.rows[0]) {
            await query(
                `UPDATE new_order_processes SET status = 11, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [processResult.rows[0].id]
            );
        }

        // Update order status back to 11 (rejected)
        await query(
            `UPDATE new_orders SET new_order_status = 11, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [id]
        );

        // Clear website selections and store rejection reason in process details
        if (processResult.rows[0]) {
            await query(
                `UPDATE new_order_process_details 
                 SET status = 11, reject_reason = $1, updated_at = CURRENT_TIMESTAMP 
                 WHERE new_order_process_id = $2`,
                [reason || 'Rejected by manager', processResult.rows[0].id]
            );
        }

        res.json({
            message: 'Team submission rejected and sent back to team',
            order_id: id,
            rejection_reason: reason
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/manager/team-members
 * @desc    Get all team members for assignment dropdown
 * @access  Manager only
 */
const getTeamMembers = async (req, res, next) => {
    try {
        const result = await query(
            "SELECT id, name, name as username, email FROM users WHERE LOWER(role) = 'team' ORDER BY name"
        );

        res.json({
            count: result.rows.length,
            users: result.rows
        });
    } catch (error) {
        next(error);
    }
};

const getWriters = async (req, res, next) => {
    try {
        const result = await query(
            "SELECT id, name as username, email FROM users WHERE LOWER(role) = 'writer' ORDER BY name"
        );

        res.json({
            count: result.rows.length,
            users: result.rows
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/manager/bloggers
 * @desc    Get all bloggers for assignment dropdown
 * @access  Manager only
 */
const getBloggers = async (req, res, next) => {
    try {
        const result = await query(
            "SELECT id, username, email FROM users WHERE role = 'Blogger' AND is_active = true ORDER BY username"
        );

        res.json({
            count: result.rows.length,
            bloggers: result.rows
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/manager/websites
 * @desc    Get all websites/sites for manager view (with pagination)
 * @access  Manager only
 */
const getWebsites = async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        // Build dynamic WHERE conditions as an array
        const conditions = [`(ns.delete_site IS NULL OR ns.delete_site = 0)`, `ns.site_status = '1'`];
        const queryParams = [];
        let paramIndex = 1;

        // Text Search Filters
        if (req.query.search_domain) {
            conditions.push(`ns.root_domain ILIKE $${paramIndex}`);
            queryParams.push(`%${req.query.search_domain}%`);
            paramIndex++;
        }
        if (req.query.search_category) {
            conditions.push(`(ns.category ILIKE $${paramIndex} OR ns.niche ILIKE $${paramIndex})`);
            queryParams.push(`%${req.query.search_category}%`);
            paramIndex++;
        }
        if (req.query.search_niche) {
            conditions.push(`ns.website_niche ILIKE $${paramIndex}`);
            queryParams.push(`%${req.query.search_niche}%`);
            paramIndex++;
        }
        if (req.query.search_email) {
            conditions.push(`ns.email ILIKE $${paramIndex}`);
            queryParams.push(`%${req.query.search_email}%`);
            paramIndex++;
        }

        // Dropdown Filters (override the default 'Approved' if explicitly set)
        if (req.query.filter_website_status) {
            // Remove the default approved filter and apply the explicit one
            const idx = conditions.indexOf(`ns.site_status = '1'`);
            if (idx > -1) conditions.splice(idx, 1);
            conditions.push(`ns.site_status = $${paramIndex}`);
            const val = req.query.filter_website_status === 'Approved' ? '1' : req.query.filter_website_status === 'Rejected' ? '2' : '0';
            queryParams.push(val);
            paramIndex++;
        }
        if (req.query.filter_status && !req.query.filter_website_status) {
            const idx = conditions.indexOf(`ns.site_status = '1'`);
            if (idx > -1) conditions.splice(idx, 1);
            conditions.push(`ns.site_status = $${paramIndex}`);
            const val = req.query.filter_status === 'Approved' ? '1' : req.query.filter_status === 'Rejected' ? '2' : '0';
            queryParams.push(val);
            paramIndex++;
        }
        if (req.query.filter_fc_gp) {
            if (req.query.filter_fc_gp === 'yes') conditions.push(`(ns.fc_gp IS NOT NULL AND ns.fc_gp != '')`);
            else if (req.query.filter_fc_gp === 'no') conditions.push(`(ns.fc_gp IS NULL OR ns.fc_gp = '')`);
        }
        if (req.query.filter_fc_ne) {
            if (req.query.filter_fc_ne === 'yes') conditions.push(`(ns.fc_ne IS NOT NULL AND ns.fc_ne != '')`);
            else if (req.query.filter_fc_ne === 'no') conditions.push(`(ns.fc_ne IS NULL OR ns.fc_ne = '')`);
        }
        if (req.query.filter_new_arrival) {
            if (req.query.filter_new_arrival === 'yes') conditions.push(`ns.created_at >= NOW() - INTERVAL '7 days'`);
            else if (req.query.filter_new_arrival === 'no') conditions.push(`ns.created_at < NOW() - INTERVAL '7 days'`);
        }
        if (req.query.filter_added_on) {
            conditions.push(`DATE(ns.created_at) = $${paramIndex}`);
            queryParams.push(req.query.filter_added_on);
            paramIndex++;
        }

        // Numeric Range Filters helper
        const addRangeFilter = (paramKey, dbCol) => {
            const val = req.query[`filter_${paramKey}_val`];
            const op = req.query[`filter_${paramKey}_op`];
            if (val && op) {
                let sqlOp = '=';
                if (op === '>') sqlOp = '>';
                else if (op === '<') sqlOp = '<';
                
                const castCol = `(CASE WHEN ${dbCol}::text ~ '^[0-9]+(\\.[0-9]+)?$' THEN ${dbCol}::numeric ELSE 0 END)`;
                conditions.push(`${castCol} ${sqlOp} $${paramIndex}`);
                queryParams.push(parseFloat(val));
                paramIndex++;
            }
        };

        addRangeFilter('da', 'ns.da');
        addRangeFilter('dr', 'ns.dr');
        addRangeFilter('rd', 'ns.rd');
        addRangeFilter('traffic', 'ns.traffic_source');
        addRangeFilter('gp_price', 'ns.gp_price');
        addRangeFilter('niche_price', 'ns.niche_edit_price');

        const whereClause = conditions.join(' AND ');

        // Execute Count query (same filters, no pagination)
        const countResult = await query(
            `SELECT COUNT(*) as total FROM new_sites ns WHERE ${whereClause}`,
            queryParams
        );
        const total = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(total / limit);

        // Execute Data query (with pagination)
        const dataParams = [...queryParams, limit, offset];
        const result = await query(
            `SELECT ns.id, ns.root_domain, ns.niche, ns.category,
                ns.da, ns.dr, ns.rd, ns.spam_score, ns.traffic_source as traffic,
                ns.gp_price, ns.niche_edit_price, ns.deal_cbd_casino,
                ns.email, ns.site_status, ns.website_status,
                ns.fc_gp, ns.fc_ne, ns.website_niche, ns.sample_url, ns.href_url,
                ns.paypal_id, ns.skype, ns.whatsapp, ns.country_source,
                ns.created_at, ns.updated_at,
                (SELECT MAX(nopd.created_at) FROM new_order_process_details nopd WHERE nopd.new_site_id = ns.id) as lo_created_at
             FROM new_sites ns
             WHERE ${whereClause}
             ORDER BY ns.created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            dataParams
        );

        res.json({
            sites: result.rows,
            pagination: { page, limit, total, totalPages }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/manager/tasks/:id/push-to-bloggers
 * @desc    Push task to bloggers - auto-routes each site to its owner
 * @access  Manager only
 * 
 * This function automatically assigns each selected website to its owner (vendor).
 * The vendor_id is set to the uploaded_user_id from new_sites table.
 */
const pushToBloggers = async (req, res, next) => {
    try {
        const { id } = req.params; // order ID
        const sendEmailFlag = req.body.send_email !== false; // default true

        // Get the latest process for this order
        const processResult = await query(
            `SELECT id FROM new_order_processes WHERE new_order_id = $1 ORDER BY id DESC LIMIT 1`,
            [id]
        );

        if (!processResult.rows[0]) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'No process found for this order'
            });
        }

        const processId = processResult.rows[0].id;

        // Get all process details and their site owners
        const details = await query(
            `SELECT
nopd.id as detail_id,
    nopd.new_site_id,
    ns.uploaded_user_id as site_owner_id,
    ns.root_domain,
    u.name as owner_name,
    u.email as owner_email
             FROM new_order_process_details nopd
             JOIN new_sites ns ON nopd.new_site_id = ns.id
             LEFT JOIN users u ON ns.uploaded_user_id = u.id
             WHERE nopd.new_order_process_id = $1`,
            [processId]
        );

        if (details.rows.length === 0) {
            return res.status(400).json({
                error: 'No websites found',
                message: 'No websites are selected for this order'
            });
        }

        // Auto-route each site to its owner
        const pushedTasks = [];
        for (const detail of details.rows) {
            // Update the detail with vendor_id = site owner
            await query(
                `UPDATE new_order_process_details 
                 SET vendor_id = $1, status = 5, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [detail.site_owner_id, detail.detail_id]
            );

            // Create notification for the vendor/blogger
            try {
                await query(
                    `INSERT INTO notifications(id, type, notifiable_type, notifiable_id, data, created_at, updated_at)
VALUES(gen_random_uuid(), 'order_assigned', 'App\\Models\\User', $1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                    [
                        detail.site_owner_id,
                        JSON.stringify({
                            message: `New task assigned for ${detail.root_domain}`,
                            order_id: id,
                            detail_id: detail.detail_id
                        })
                    ]
                );
            } catch (notifError) {
                console.log('Notification creation skipped (table might not exist):', notifError.message);
            }

            pushedTasks.push({
                detail_id: detail.detail_id,
                root_domain: detail.root_domain,
                vendor_id: detail.site_owner_id,
                vendor_name: detail.owner_name,
                vendor_email: detail.owner_email
            });
        }

        // Update process status to 5 (assigned to vendors)
        await query(
            `UPDATE new_order_processes SET status = 5, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [processId]
        );

        // Update order status to 4 (With Blogger) - NOT 5 (Completed)
        await query(
            `UPDATE new_orders SET new_order_status = 4, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [id]
        );

        // If this order was linked to a client order, update the client order status to 'pushed_to_blogger'
        await query(
            `UPDATE client_orders SET status = 'pushed_to_blogger', updated_at = CURRENT_TIMESTAMP WHERE linked_new_order_id = $1`,
            [id]
        );

        // Emit socket event for real-time updates
        const io = req.app.get('io');
        if (io) {
            pushedTasks.forEach(task => {
                io.emit(`vendor_${task.vendor_id} _new_task`, {
                    message: `New task assigned for ${task.root_domain}`,
                    order_id: id
                });
            });
        }

        // Send grouped email notifications per blogger (if toggle is ON)
        if (sendEmailFlag && pushedTasks.length > 0) {
            try {
                // Group tasks by vendor (blogger)
                const grouped = {};
                for (const task of pushedTasks) {
                    if (!task.vendor_email) continue;
                    if (!grouped[task.vendor_id]) {
                        grouped[task.vendor_id] = { email: task.vendor_email, name: task.vendor_name, tasks: [] };
                    }
                    // Get order_id for this task
                    const orderIdResult = await query(
                        `SELECT no.order_id FROM new_order_process_details nopd JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id JOIN new_orders no ON nop.new_order_id = no.id WHERE nopd.id = $1`,
                        [task.detail_id]
                    );
                    grouped[task.vendor_id].tasks.push({
                        root_domain: task.root_domain,
                        order_id: orderIdResult.rows[0]?.order_id || `ORD-${id}`
                    });
                }
                // Send ONE email per blogger
                for (const vendorId of Object.keys(grouped)) {
                    const g = grouped[vendorId];
                    sendOrderAssignedEmail(g.email, g.name, g.tasks);
                }
            } catch (emailErr) {
                console.error('Order assigned email failed (non-blocking):', emailErr.message);
            }
        }

        res.json({
            message: 'Tasks pushed to bloggers successfully',
            pushed_count: pushedTasks.length,
            tasks: pushedTasks,
            emails_sent: sendEmailFlag
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/manager/blogger-submissions/:id
 * @desc    Get full detail of a blogger's submission for manager review
 * @access  Manager only
 * 
 * id = new_order_process_details.id (detail_id)
 */
const getBloggerSubmissionDetail = async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(
            `SELECT 
                nopd.id as detail_id,
        nopd.new_order_process_id as process_id,
        nopd.new_site_id as site_id,
        nopd.vendor_id,
        nopd.status as detail_status,
        nopd.submit_url,
        nopd.anchor,
        nopd.url as target_url,
        COALESCE(nopd.ourl, nopd.doc_urls) as post_url,
        nopd.type as option,
        nopd.insert_after,
        nopd.statement,
        nopd.note as notes,
        nopd.upfront_payment,
        nopd.doc_urls,
        nopd.title,
        nopd.upload_doc_file,
        nopd.link_status,
        nopd.link_check_result,
        nopd.created_at,
        nopd.updated_at,
        ns.root_domain,
        ns.da,
        ns.dr,
        ns.gp_price,
        ns.niche_edit_price as niche_price,
        ns.fc_gp,
        ns.fc_ne,
        v.name as vendor_name,
        v.email as vendor_email,
        nop.new_order_id as order_id,
        no.order_id as manual_order_id,
        no.client_name,
        no.order_type,
        no.category,
        no.fc,
        no.message as order_notes
             FROM new_order_process_details nopd
             JOIN new_sites ns ON nopd.new_site_id = ns.id
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             JOIN new_orders no ON nop.new_order_id = no.id
             LEFT JOIN users v ON nopd.vendor_id = v.id
             WHERE nopd.id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Submission not found'
            });
        }

        const row = result.rows[0];
        const detail = {
            id: row.detail_id,
            order_id: row.manual_order_id || `ORD-${row.order_id}`,

            // Vendor/Blogger info
            vendor_id: row.vendor_id,
            vendor_name: row.vendor_name,
            vendor_email: row.vendor_email,

            // Site info
            root_domain: row.root_domain,
            da: row.da,
            dr: row.dr,
            price: (() => {
                const type = (row.order_type || '').toLowerCase();
                const isFC = Number(row.fc) === 1;
                if (type.includes('niche') || type.includes('edit') || type.includes('insertion')) {
                    if (isFC && row.fc_ne && !isNaN(parseFloat(row.fc_ne)) && parseFloat(row.fc_ne) > 0) {
                        return parseFloat(row.fc_ne);
                    }
                    return (row.niche_price && !isNaN(parseFloat(row.niche_price))) ? parseFloat(row.niche_price) : 0;
                }
                if (isFC && row.fc_gp && !isNaN(parseFloat(row.fc_gp)) && parseFloat(row.fc_gp) > 0) {
                    return parseFloat(row.fc_gp);
                }
                return (row.gp_price && !isNaN(parseFloat(row.gp_price))) ? parseFloat(row.gp_price) : 0;
            })(),

            // Order details (matching Screenshot 3)
            post_url: row.post_url,
            insert_after: row.insert_after,
            insert_statement: row.statement,
            anchor: row.anchor,
            url: row.target_url,

            // Submission
            submitted_url: row.submit_url,
            submit_url: row.submit_url,
            link_verification: row.link_status ? `${row.link_status}${row.link_check_result ? ' - ' + row.link_check_result : ''}` : 'Not Verified',
            link_status: row.link_status || null,
            link_check_result: row.link_check_result || null,
            upfront_payment: row.upfront_payment || false,

            // Order info
            order_type: row.order_type,
            category: row.category,
            client_name: row.client_name,
            notes: row.notes,

            // Doc/Content fields
            doc_urls: row.doc_urls,
            title: row.title,
            upload_doc_file: row.upload_doc_file,

            // Status
            detail_status: row.detail_status,

            created_at: row.created_at,
            updated_at: row.updated_at
        };

        res.json({ detail });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/manager/blogger-submissions/:id/finalize
 * @desc    Finalize blogger submission - mark as complete and credit blogger
 * @access  Manager only
 * 
 * id = new_order_process_details.id (detail_id)
 */
const finalizeFromBlogger = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { credit_amount } = req.body;

        // Get the detail first
        const detailResult = await query(
            `SELECT nopd.*, ns.root_domain, ns.niche_edit_price as niche_price, ns.gp_price, ns.fc_gp, ns.fc_ne, v.name as vendor_name, no.order_type, no.fc
             FROM new_order_process_details nopd
             JOIN new_sites ns ON nopd.new_site_id = ns.id
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             JOIN new_orders no ON nop.new_order_id = no.id
             LEFT JOIN users v ON nopd.vendor_id = v.id
             WHERE nopd.id = $1`,
            [id]
        );

        if (detailResult.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Submission not found'
            });
        }

        const detail = detailResult.rows[0];

        // STATE GUARD: Prevent double-crediting already finalized orders
        if (parseInt(detail.status) === 8) {
            return res.status(400).json({
                error: 'Invalid Action',
                message: 'This task is already finalized and credited. Cannot finalize again.'
            });
        }
        
        // STATE GUARD: Prevent finalizing orders rejected by bloggers
        if (parseInt(detail.status) === 12) {
            return res.status(400).json({
                error: 'Invalid Action',
                message: 'This task was rejected by the blogger. You cannot finalize and credit a rejected task.'
            });
        }

        // Update status to 8 (completed/credited)
        await query(
            `UPDATE new_order_process_details 
             SET status = 8, reject_reason = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [id]
        );

        // Credit the blogger's wallet - strictly match price to order_type + FC
        // Strip non-numeric characters (like $) from price strings before parsing
        const cleanPrice = (val) => {
            if (!val) return 0;
            const cleaned = String(val).replace(/[^0-9.]/g, '');
            const parsed = parseFloat(cleaned);
            return isNaN(parsed) ? 0 : parsed;
        };

        let amount = 0;
        if (credit_amount) {
            amount = parseFloat(credit_amount);
        } else {
            const orderType = (detail.order_type || '').toLowerCase();
            const isFC = detail.fc == 1 || detail.fc === true;
            if (orderType.includes('niche') || orderType.includes('edit') || orderType.includes('insertion')) {
                amount = (isFC && cleanPrice(detail.fc_ne) > 0) ? cleanPrice(detail.fc_ne) : cleanPrice(detail.niche_price);
            } else {
                amount = (isFC && cleanPrice(detail.fc_gp) > 0) ? cleanPrice(detail.fc_gp) : cleanPrice(detail.gp_price);
            }
        }

        if (amount > 0 && detail.vendor_id) {
            try {
                await addCreditToBloggerWallet(detail.vendor_id, amount, id); // Pass order_detail_id for wallet history linkage
            } catch (walletError) {
                console.log('Wallet credit skipped:', walletError.message);
            }
        }

        // Check if all details for this process are completed or rejected by blogger
        const processCheck = await query(
            `SELECT COUNT(*) as pending FROM new_order_process_details 
             WHERE new_order_process_id = $1 AND status NOT IN (8, 12)`,
            [detail.new_order_process_id]
        );

        const allLinksComplete = parseInt(processCheck.rows[0].pending) === 0;

        // If all details are complete, update process AND order status
        if (allLinksComplete) {
            await query(
                `UPDATE new_order_processes SET status = 8, updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $1`,
                [detail.new_order_process_id]
            );

            // Also update the parent order status to complete
            const parentOrderQuery = `SELECT new_order_id FROM new_order_processes WHERE id = $1`;
            const parentOrderRes = await query(parentOrderQuery, [detail.new_order_process_id]);
            const newOrderId = parentOrderRes.rows[0]?.new_order_id;

            if (newOrderId) {
                await query(
                    `UPDATE new_orders SET new_order_status = 5, completed_tasks = completed_tasks + 1, updated_at = CURRENT_TIMESTAMP 
                     WHERE id = $1`,
                    [newOrderId]
                );

                // Update the linked client order to 'completed'
                await query(
                    `UPDATE client_orders SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE linked_new_order_id = $1`,
                    [newOrderId]
                );
            }
        }

        res.json({
            message: allLinksComplete
                ? 'Order finalized! All links are complete.'
                : 'Link credited successfully. Order still has pending links.',
            detail_id: id,
            root_domain: detail.root_domain,
            vendor_name: detail.vendor_name,
            credited_amount: amount,
            all_links_complete: allLinksComplete
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/manager/blogger-submissions/:id/reject
 * @desc    Reject blogger submission - sends back to blogger with reason
 * @access  Manager only
 */
const rejectBloggerSubmission = async (req, res, next) => {
    try {
        const { id } = req.params;
        const rejection_reason = req.body.rejection_reason || req.body.reject_reason;

        if (!rejection_reason) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Rejection reason is required'
            });
        }

        // Check if detail exists
        const detailResult = await query(
            `SELECT nopd.*, ns.root_domain, u.name as vendor_name
             FROM new_order_process_details nopd
             LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
             LEFT JOIN users u ON nopd.vendor_id = u.id
             WHERE nopd.id = $1`,
            [id]
        );

        if (detailResult.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Blogger submission not found'
            });
        }

        const detail = detailResult.rows[0];

        // AUTO-REFUND: If this order was already credited (status 8), reverse the wallet credit
        let refundInfo = null;
        if (parseInt(detail.status) === 8 && detail.vendor_id) {
            // Find the wallet and any credit entry for this order
            const walletRes = await query(
                'SELECT id FROM wallets WHERE user_id = $1',
                [detail.vendor_id]
            );
            if (walletRes.rows[0]) {
                const walletId = walletRes.rows[0].id;

                // Delete the credit entry for this order detail
                const deletedCredits = await query(
                    `DELETE FROM wallet_histories 
                     WHERE wallet_id = $1 AND order_detail_id = $2 AND type = 'credit'
                     RETURNING id, price`,
                    [walletId, id]
                );

                const refundedAmount = deletedCredits.rows.reduce(
                    (sum, r) => sum + parseFloat(r.price || 0), 0
                );

                // Recalculate the true wallet balance
                const creditSum = await query(
                    `SELECT COALESCE(SUM(CAST(price AS NUMERIC)), 0) as total 
                     FROM wallet_histories WHERE wallet_id = $1 AND type = 'credit'`,
                    [walletId]
                );
                const debitSum = await query(
                    `SELECT COALESCE(SUM(CAST(price AS NUMERIC)), 0) as total 
                     FROM wallet_histories WHERE wallet_id = $1 AND type = 'debit'`,
                    [walletId]
                );
                const trueBalance = parseFloat(creditSum.rows[0].total) - parseFloat(debitSum.rows[0].total);

                await query(
                    'UPDATE wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                    [trueBalance, walletId]
                );

                refundInfo = {
                    credits_removed: deletedCredits.rows.length,
                    refunded_amount: refundedAmount,
                    new_balance: trueBalance
                };
                console.log(`💰 Auto-refund: Removed $${refundedAmount} from blogger ${detail.vendor_id} wallet for rejected order detail ${id}. New balance: $${trueBalance}`);
            }
        }

        // Update status to 11 (Rejected) and store rejection reason
        await query(
            `UPDATE new_order_process_details 
             SET status = 11, reject_reason = $1, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $2`,
            [rejection_reason, id]
        );

        res.json({
            message: refundInfo
                ? `Blogger submission rejected and $${refundInfo.refunded_amount} refunded from wallet`
                : 'Blogger submission rejected successfully',
            detail_id: id,
            root_domain: detail.root_domain,
            vendor_name: detail.vendor_name,
            rejection_reason,
            refund: refundInfo
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/manager/orders/create/chain
 * @desc    Create order and directly push to Writer or Blogger (bypassing steps)
 * @access  Manager only
 */
const createOrderChain = async (req, res, next) => {
    try {
        const {
            client_name, order_type, no_of_links, notes,
            manual_order_id, client_website, fc, order_package, category,
            target_stage, websites, content_data, assigned_writer_id,
            send_email: sendEmailFlag = true
        } = req.body;

        if (!client_name) {
            return res.status(400).json({ error: 'Validation Error', message: 'Client name is required' });
        }
        if (!websites || !Array.isArray(websites) || websites.length === 0) {
            return res.status(400).json({ error: 'Validation Error', message: 'At least one website must be selected' });
        }
        if (target_stage === 'writer' && !assigned_writer_id) {
            return res.status(400).json({ error: 'Validation Error', message: 'Writer ID is required' });
        }

        if (target_stage === 'blogger') {
            for (const w of websites) {
                const siteResult = await query('SELECT uploaded_user_id, root_domain FROM new_sites WHERE id = $1', [w.id]);
                const vendorId = siteResult.rows[0]?.uploaded_user_id || w.vendor_id || null;
                if (!vendorId) {
                    return res.status(400).json({
                        error: 'Validation Error',
                        message: `Cannot push directly to blogger. Site "${siteResult.rows[0]?.root_domain || w.id}" does not have an assigned vendor/owner in the database.`
                    });
                }
            }
        }

        const orderId = manual_order_id || `ORD-${Date.now()}`;

        // Sub-orders are allowed to reuse existing order IDs

        // Create order
        const orderResult = await query(
            `INSERT INTO new_orders (manager_id, team_id, order_id, client_name, client_website, no_of_links, order_type, order_package, message, category, new_order_status, fc, type, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING *`,
            [req.user.id, 0, orderId, client_name, client_website || '', no_of_links || websites.length, order_type || 'Guest Post', order_package || '', notes || '', category || '', target_stage === 'writer' ? 3 : 4, fc ? 1 : 0, order_type || 'Guest Post']
        );
        const order = orderResult.rows[0];

        // Create process
        const processResult = await query(
            `INSERT INTO new_order_processes (new_order_id, team_id, manager_id, writer_id, status, note, statement, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`,
            [order.id, 0, req.user.id, target_stage === 'writer' ? assigned_writer_id : null, target_stage === 'writer' ? 3 : 5, notes || '', content_data?.instructions || '']
        );
        const processId = processResult.rows[0].id;

        // Create details
        for (const w of websites) {
            // For blogger stage, try to get vendor_id from the site
            let vendorId = null;
            if (target_stage === 'blogger') {
                const siteResult = await query('SELECT uploaded_user_id FROM new_sites WHERE id = $1', [w.id]);
                vendorId = siteResult.rows[0]?.uploaded_user_id || null;
            }

            await query(
                `INSERT INTO new_order_process_details (new_order_process_id, new_site_id, url, anchor, title, note, doc_urls, ourl, insert_after, statement, upfront_payment, paypal_email, price, vendor_id, status, type, created_at, updated_at) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [processId, w.id, w.target_url || '', w.anchor_text || '', w.article_title || '', w.note || '',
                    w.doc_url || w.copyUrl || '', w.post_url || '', w.option_type === 'replace' ? w.replace_with : w.insert_after || '',
                    w.option_type === 'replace' ? w.replace_statement : w.insert_statement || '',
                    w.upfront_payment ? 1 : 0, w.paypal_id || '', 0, vendorId,
                    target_stage === 'writer' ? 3 : 5, w.option_type || 'insert']
            );
        }

        // Send email notifications if pushing to bloggers and toggle is ON
        if (target_stage === 'blogger' && sendEmailFlag) {
            try {
                const grouped = {};
                for (const w of websites) {
                    const siteResult = await query('SELECT uploaded_user_id, root_domain FROM new_sites WHERE id = $1', [w.id]);
                    const vendorId = siteResult.rows[0]?.uploaded_user_id;
                    if (!vendorId) continue;
                    if (!grouped[vendorId]) {
                        const userResult = await query('SELECT name, email FROM users WHERE id = $1', [vendorId]);
                        grouped[vendorId] = { email: userResult.rows[0]?.email, name: userResult.rows[0]?.name, tasks: [] };
                    }
                    grouped[vendorId].tasks.push({ root_domain: siteResult.rows[0]?.root_domain, order_id: orderId });
                }
                for (const vendorId of Object.keys(grouped)) {
                    const g = grouped[vendorId];
                    if (g.email) sendOrderAssignedEmail(g.email, g.name, g.tasks);
                }
            } catch (emailErr) {
                console.error('CreateOrderChain email failed (non-blocking):', emailErr.message);
            }
        }

        res.status(201).json({ message: `Order created and pushed to ${target_stage}`, order: { id: order.id, order_id: orderId } });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/manager/tasks/:id/reject-writer
 * @desc    Reject writer submission - return content to writer with rejection reasons per website
 * @access  Manager only
 */
const rejectWriterSubmission = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { rejection_reason, rejected_websites } = req.body;

        if (!rejection_reason) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Rejection reason is required'
            });
        }

        // Get the latest process for this order
        const processResult = await query(
            `SELECT id FROM new_order_processes WHERE new_order_id = $1 ORDER BY id DESC LIMIT 1`,
            [id]
        );

        if (!processResult.rows[0]) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'No process found for this order'
            });
        }

        const processId = processResult.rows[0].id;

        // If specific websites were rejected, update those detail records
        if (rejected_websites && Array.isArray(rejected_websites) && rejected_websites.length > 0) {
            for (const rw of rejected_websites) {
                await query(
                    `UPDATE new_order_process_details 
                     SET status = 11, reject_reason = $1, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2 AND new_order_process_id = $3`,
                    [rw.reason || rejection_reason, rw.detail_id || rw.website_id, processId]
                );
            }
        } else {
            // Reject all details back to writer
            await query(
                `UPDATE new_order_process_details 
                 SET status = 11, reject_reason = $1, updated_at = CURRENT_TIMESTAMP
                 WHERE new_order_process_id = $2`,
                [rejection_reason, processId]
            );
        }

        // Update process status to 11 (rejected)
        await query(
            `UPDATE new_order_processes SET status = 11, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [processId]
        );

        // Update order status to 11 (rejected)
        await query(
            `UPDATE new_orders SET new_order_status = 11, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [id]
        );

        res.json({
            message: 'Content rejected and returned to writer',
            order_id: id,
            rejection_reason
        });
    } catch (error) {
        next(error);
    }
};

// ==================== PROFILE MANAGEMENT ====================

/**
 * @route   GET /api/manager/profile
 * @desc    Get current manager's profile
 * @access  Manager only
 */
const getProfile = async (req, res, next) => {
    try {
        const result = await query(
            `SELECT id, name, email, gender, mobile_number, profile_image, whatsapp, skype, created_at
             FROM users WHERE id = $1`,
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'User not found'
            });
        }

        const user = result.rows[0];
        res.json({
            id: user.id,
            name: user.name,
            email: user.email,
            gender: user.gender || '',
            mobile: user.mobile_number || '',
            profile_image: user.profile_image || '',
            whatsapp: user.whatsapp || '',
            skype: user.skype || '',
            created_at: user.created_at
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/manager/profile
 * @desc    Update current manager's profile
 * @access  Manager only
 */
const updateProfile = async (req, res, next) => {
    try {
        const { name, gender, mobile } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Name is required'
            });
        }

        await query(
            `UPDATE users SET name = $1, gender = $2, mobile_number = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
            [name.trim(), gender || null, mobile || null, req.user.id]
        );

        res.json({ message: 'Profile updated successfully' });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/manager/profile/image
 * @desc    Upload manager profile image
 * @access  Manager only
 */
const uploadProfileImage = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'No image file provided'
            });
        }

        const imagePath = `/uploads/profiles/${req.file.filename}`;

        await query(
            `UPDATE users SET profile_image = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [imagePath, req.user.id]
        );

        res.json({
            message: 'Profile image uploaded successfully',
            profile_image: imagePath
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   DELETE /api/manager/orders/:id
 * @desc    Hard delete an order and cascade delete its processes and details
 * @access  Manager only
 */
const deleteOrder = async (req, res, next) => {
    try {
        const { id } = req.params;
        const managerId = req.user.id;

        await query('BEGIN');

        // 1. Verify exact ownership/existence
        const orderCheck = await query('SELECT id FROM new_orders WHERE id = $1 AND manager_id = $2', [id, managerId]);
        if (orderCheck.rows.length === 0) {
            await query('ROLLBACK');
            return res.status(404).json({ error: 'Order not found or unauthorized' });
        }

        // 2. Cascade Details
        await query(`
            DELETE FROM new_order_process_details 
            WHERE new_order_process_id IN (
                SELECT id FROM new_order_processes WHERE new_order_id = $1
            )
        `, [id]);

        // 3. Cascade Processes
        await query('DELETE FROM new_order_processes WHERE new_order_id = $1', [id]);

        // 4. Delete Root Order
        await query('DELETE FROM new_orders WHERE id = $1', [id]);

        await query('COMMIT');
        res.json({ success: true, message: 'Order permanently deleted' });

    } catch (error) {
        await query('ROLLBACK');
        console.error("Delete Order Error:", error);
        next(error);
    }
};

// ==================== CLIENT ORDER MANAGEMENT ====================

/**
 * @route   GET /api/manager/client-orders
 * @desc    Get all client orders for manager review
 * @access  Manager only
 */
const getClientOrders = async (req, res, next) => {
    try {
        const { page = 1, limit = 20, status, manager_id } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = 'WHERE 1=1';
        const params = [];
        let paramIndex = 1;

        // Restrict to manager's assigned orders if called by a manager
        const userRole = (req.user.role || '').toLowerCase();
        if (userRole === 'manager') {
            whereClause += ` AND co.assigned_to = $${paramIndex}`;
            params.push(req.user.id);
            paramIndex++;
        } else if (manager_id) {
            if (manager_id === 'unassigned') {
                whereClause += ` AND co.assigned_to IS NULL`;
            } else {
                whereClause += ` AND co.assigned_to = $${paramIndex}`;
                params.push(manager_id);
                paramIndex++;
            }
        }

        if (status) {
            if (status === 'pending_review') {
                whereClause += ` AND co.status = 'pending_review'`;
            } else if (status === 'sent_to_writer') {
                whereClause += ` AND co.status = 'sent_to_writer' AND (SELECT nop.status FROM new_order_processes nop WHERE nop.new_order_id = co.linked_new_order_id ORDER BY nop.id DESC LIMIT 1) = 3`;
            } else if (status === 'writer_approved') {
                whereClause += ` AND co.status = 'sent_to_writer' AND (SELECT nop.status FROM new_order_processes nop WHERE nop.new_order_id = co.linked_new_order_id ORDER BY nop.id DESC LIMIT 1) = 4`;
            } else if (status === 'blogger_approved') {
                whereClause += ` AND (co.status = 'pushed_to_blogger' OR co.status = 'completed' OR (co.status = 'sent_to_writer' AND (SELECT nop.status FROM new_order_processes nop WHERE nop.new_order_id = co.linked_new_order_id ORDER BY nop.id DESC LIMIT 1) = 5))`;
            } else {
                whereClause += ` AND co.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }
        }

        const countResult = await query(
            `SELECT COUNT(*) as total FROM client_orders co ${whereClause}`,
            params
        );

        const ordersResult = await query(
            `SELECT co.*, 
                    u.name as client_name, u.name as client_name_user, u.email as client_email,
                    am.name as assigned_manager_name,
                    (SELECT ns.root_domain FROM client_order_details cod LEFT JOIN new_sites ns ON ns.id = cod.site_id WHERE cod.client_order_id = co.id LIMIT 1) as client_website,
                    (SELECT COUNT(*) FROM client_order_details cod WHERE cod.client_order_id = co.id) as site_count,
                    (SELECT nop.status FROM new_order_processes nop WHERE nop.new_order_id = co.linked_new_order_id ORDER BY nop.id DESC LIMIT 1) as linked_process_status,
                    (SELECT w.name FROM new_order_processes nop LEFT JOIN users w ON nop.writer_id = w.id WHERE nop.new_order_id = co.linked_new_order_id ORDER BY nop.id DESC LIMIT 1) as assigned_writer_name,
                    (SELECT COUNT(*) FROM new_order_process_details nopd JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id WHERE nop.new_order_id = co.linked_new_order_id AND nopd.status = 7) as pending_blogger_submissions_count,
                    (SELECT COUNT(*) FROM new_order_process_details nopd JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id WHERE nop.new_order_id = co.linked_new_order_id AND nopd.status = 8) as completed_blogger_submissions_count
             FROM client_orders co 
             LEFT JOIN users u ON u.id = co.client_user_id
             LEFT JOIN users am ON am.id = co.assigned_to
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
        next(error);
    }
};

/**
 * @route   PUT /api/admin/client-orders/:id/reassign
 * @desc    Reassign a client order to a new manager
 * @access  Admin only
 */
const reassignClientOrder = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { manager_id } = req.body;

        if (!manager_id) {
            return res.status(400).json({ error: 'Manager ID is required' });
        }

        let numericId = id;
        if (typeof id === 'string') {
            numericId = parseInt(id.replace('C-', ''));
        }

        if (isNaN(numericId)) {
            return res.status(400).json({ error: 'Invalid order ID' });
        }

        const orderRes = await query('SELECT id FROM client_orders WHERE id = $1', [numericId]);
        if (orderRes.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        // Validate that the target manager is active and has the correct role
        const managerRes = await query('SELECT role, status FROM users WHERE id = $1', [manager_id]);
        if (managerRes.rows.length === 0) {
            return res.status(404).json({ error: 'Manager not found' });
        }
        const manager = managerRes.rows[0];
        if (!manager.role || manager.role.toLowerCase() !== 'manager' || manager.status !== 1) {
            return res.status(400).json({ error: 'Selected user is not an active Manager' });
        }

        await query(
            'UPDATE client_orders SET assigned_to = $1, assigned_at = CURRENT_TIMESTAMP WHERE id = $2',
            [manager_id, numericId]
        );

        res.json({ message: 'Order reassigned successfully' });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/manager/client-orders/:id
 * @desc    Get client order details for manager to review/edit
 * @access  Manager only
 */
const getClientOrderDetails = async (req, res, next) => {
    try {
        const orderId = req.params.id;

        const orderResult = await query(
            `SELECT co.*, u.name as client_name_user, u.email as client_email,
                    nop.status as linked_process_status,
                    nop.writer_id as assigned_writer_id,
                    w.name as assigned_writer_name
             FROM client_orders co 
             LEFT JOIN users u ON u.id = co.client_user_id
             LEFT JOIN new_order_processes nop ON nop.new_order_id = co.linked_new_order_id AND nop.id = (
                 SELECT id FROM new_order_processes WHERE new_order_id = co.linked_new_order_id ORDER BY id DESC LIMIT 1
             )
             LEFT JOIN users w ON w.id = nop.writer_id
             WHERE co.id = $1`,
            [orderId]
        );

        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Client order not found' });
        }

        const detailsResult = await query(
            `SELECT cod.id, cod.client_order_id, cod.site_id, cod.fill_details,
                    COALESCE(nopd.url, cod.target_url) as target_url,
                    COALESCE(nopd.anchor, cod.anchor_text) as anchor_text,
                    COALESCE(nopd.title, cod.article_title) as article_title,
                    COALESCE(nopd.doc_urls, cod.doc_url) as doc_url,
                    COALESCE(nopd.ourl, cod.post_url) as post_url,
                    COALESCE(nopd.insert_after, cod.insert_after) as insert_after,
                    COALESCE(nopd.statement, cod.insert_statement) as insert_statement,
                    COALESCE(nopd.note, cod.note) as note,
                    nopd.upload_doc_file,
                    nopd.id as process_detail_id,
                    nopd.status as process_detail_status,
                    nopd.submit_url,
                    nopd.reject_reason as process_detail_reject_reason,
                    ns.root_domain, ns.da, ns.dr, ns.traffic, ns.gp_price, ns.niche_edit_price, 
                    ns.category as site_category, ns.uploaded_user_id as vendor_id,
                    ns.fc_gp, ns.fc_ne, ns.website_status
             FROM client_order_details cod 
             LEFT JOIN new_sites ns ON ns.id = cod.site_id 
             LEFT JOIN client_orders co ON co.id = cod.client_order_id
             LEFT JOIN new_order_processes nop ON nop.new_order_id = co.linked_new_order_id AND nop.id = (
                 SELECT id FROM new_order_processes WHERE new_order_id = co.linked_new_order_id ORDER BY id DESC LIMIT 1
             )
             LEFT JOIN new_order_process_details nopd ON nopd.new_order_process_id = nop.id AND nopd.new_site_id = cod.site_id
             WHERE cod.client_order_id = $1 
             ORDER BY cod.id`,
            [orderId]
        );

        res.json({
            order: orderResult.rows[0],
            details: detailsResult.rows
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/manager/client-orders/:id
 * @desc    Update client order details (manager can edit/add details before pushing)
 * @access  Manager only
 */
const updateClientOrder = async (req, res, next) => {
    try {
        const orderId = req.params.id;
        const { manager_notes, details } = req.body;

        // Update manager notes on the order
        if (manager_notes !== undefined) {
            await query(
                `UPDATE client_orders SET manager_notes = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                [manager_notes, orderId]
            );
        }

        // Get client order
        const orderResult = await query('SELECT linked_new_order_id FROM client_orders WHERE id = $1', [orderId]);
        const linkedNewOrderId = orderResult.rows[0]?.linked_new_order_id;

        // Update individual site details
        if (details && Array.isArray(details)) {
            for (const d of details) {
                await query(
                    `UPDATE client_order_details 
                     SET target_url = COALESCE($1, target_url), 
                         anchor_text = COALESCE($2, anchor_text),
                         article_title = COALESCE($3, article_title),
                         doc_url = COALESCE($4, doc_url),
                         post_url = COALESCE($5, post_url),
                         insert_after = COALESCE($6, insert_after),
                         insert_statement = COALESCE($7, insert_statement),
                         note = COALESCE($8, note)
                     WHERE id = $9 AND client_order_id = $10`,
                    [d.target_url, d.anchor_text, d.article_title, d.doc_url,
                     d.post_url, d.insert_after, d.insert_statement, d.note,
                     d.id, orderId]
                );

                // If linked to a standard order process, update new_order_process_details as well
                if (linkedNewOrderId) {
                    const processDetailResult = await query(
                        `SELECT nopd.id 
                         FROM new_order_process_details nopd
                         JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
                         JOIN client_order_details cod ON cod.site_id = nopd.new_site_id
                         WHERE nop.new_order_id = $1 AND cod.id = $2`,
                        [linkedNewOrderId, d.id]
                    );

                    if (processDetailResult.rows[0]) {
                        const nopdId = processDetailResult.rows[0].id;
                        await query(
                            `UPDATE new_order_process_details 
                             SET url = COALESCE($1, url), 
                                 anchor = COALESCE($2, anchor),
                                 title = COALESCE($3, title),
                                 doc_urls = COALESCE($4, doc_urls),
                                 ourl = COALESCE($5, ourl),
                                 insert_after = COALESCE($6, insert_after),
                                 statement = COALESCE($7, statement),
                                 note = COALESCE($8, note)
                             WHERE id = $9`,
                            [d.target_url, d.anchor_text, d.article_title, d.doc_url,
                             d.post_url, d.insert_after, d.insert_statement, d.note,
                             nopdId]
                        );
                    }
                }
            }
        }

        res.json({ message: 'Client order updated successfully' });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/manager/client-orders/:id/reject
 * @desc    Reject a client order and issue a full refund to their wallet
 * @access  Manager only
 */
const rejectClientOrder = async (req, res, next) => {
    try {
        const orderId = req.params.id;
        const { manager_notes } = req.body;

        // 1. Get the client order
        const orderResult = await query(
            `SELECT id, client_user_id, status, total_price, order_number 
             FROM client_orders 
             WHERE id = $1`,
            [orderId]
        );

        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Client order not found' });
        }

        const order = orderResult.rows[0];

        // 2. Ensure order isn't already rejected or completed
        if (order.status === 'rejected' || order.status === 'completed') {
            return res.status(400).json({ 
                error: 'Invalid State',
                message: `Cannot reject order because it is already ${order.status}`
            });
        }

        // 3. Update order status and notes
        await query(
            `UPDATE client_orders 
             SET status = 'rejected', manager_notes = $1, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $2`,
            [manager_notes || 'Order rejected by manager', orderId]
        );

        // 4. Issue Refund if there was a charge
        const refundAmount = parseFloat(order.total_price || 0);
        if (refundAmount > 0) {
            // Get user's wallet
            const walletResult = await query('SELECT id, balance FROM wallets WHERE user_id = $1', [order.client_user_id]);
            
            if (walletResult.rows.length > 0) {
                const walletId = walletResult.rows[0].id;
                const newBalance = parseFloat(walletResult.rows[0].balance || 0) + refundAmount;
                
                // Update wallet balance atomically
                await query(
                    'UPDATE wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                    [newBalance, walletId]
                );

                // Log refund in wallet_histories
                await query(
                    `INSERT INTO wallet_histories (wallet_id, type, price, remarks, status, created_at, updated_at, approved_date)
                     VALUES ($1, 'Credit', $2, $3, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                    [walletId, refundAmount, `Refund for rejected Order ${order.order_number || ('#' + orderId)}`]
                );
                
                logger.info('Manager', `Refunded $${refundAmount} to user ${order.client_user_id} for rejected order ${orderId}`);
            }
        }

        res.json({ message: 'Order rejected and refunded successfully' });
    } catch (error) {
        logger.error('Manager:RejectClientOrder', error);
        next(error);
    }
};

/**
 * @route   POST /api/manager/client-orders/:id/push-to-blogger
 * @desc    Push a client order to the normal order flow (creates new_orders + pushes to blogger)
 * @access  Manager only
 */
const pushClientOrderToBlogger = async (req, res, next) => {
    try {
        const clientOrderId = req.params.id;
        const managerId = req.user.id;
        const { send_email = true } = req.body;

        // Get the client order
        const orderResult = await query(
            `SELECT co.*, u.name as client_name_user 
             FROM client_orders co 
             LEFT JOIN users u ON u.id = co.client_user_id 
             WHERE co.id = $1`,
            [clientOrderId]
        );

        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Client order not found' });
        }

        const clientOrder = orderResult.rows[0];

        if (clientOrder.status === 'pushed_to_blogger' || clientOrder.status === 'completed') {
            return res.status(400).json({ error: 'This order has already been processed' });
        }

        // Get the order details
        const detailsResult = await query(
            `SELECT cod.*, ns.root_domain, ns.uploaded_user_id as vendor_id, ns.gp_price, ns.niche_edit_price
             FROM client_order_details cod 
             LEFT JOIN new_sites ns ON ns.id = cod.site_id 
             WHERE cod.client_order_id = $1`,
            [clientOrderId]
        );

        if (detailsResult.rows.length === 0) {
            return res.status(400).json({ error: 'No sites found in this order' });
        }

        // Verify all sites have a vendor
        for (const d of detailsResult.rows) {
            if (!d.vendor_id) {
                return res.status(400).json({
                    error: `Site "${d.root_domain}" does not have an owner. Cannot push to blogger.`
                });
            }
        }

        const orderId = `CLT-${clientOrderId}-${Date.now()}`;
        const isNicheEdit = (clientOrder.order_type || '').toLowerCase().includes('niche');

        // Create the standard order
        const newOrderResult = await query(
            `INSERT INTO new_orders (manager_id, team_id, order_id, client_name, client_website, no_of_links, order_type, order_package, message, category, new_order_status, type, created_at, updated_at)
             VALUES ($1, 0, $2, $3, '', $4, $5, $6, $7, $8, 4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`,
            [managerId, orderId, clientOrder.client_name_user || 'Client', detailsResult.rows.length, clientOrder.order_type, clientOrder.order_package || '', clientOrder.notes || '', clientOrder.category || '']
        );
        const newOrderId = newOrderResult.rows[0].id;

        // Create the process
        const processResult = await query(
            `INSERT INTO new_order_processes (new_order_id, team_id, manager_id, status, note, created_at, updated_at) 
             VALUES ($1, 0, $2, 5, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`,
            [newOrderId, managerId, clientOrder.manager_notes || clientOrder.notes || '']
        );
        const processId = processResult.rows[0].id;

        // Create details and push to bloggers
        const pushedTasks = [];
        for (const d of detailsResult.rows) {
            await query(
                `INSERT INTO new_order_process_details 
                 (new_order_process_id, new_site_id, url, anchor, title, note, doc_urls, ourl, insert_after, statement, price, vendor_id, status, type, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, 5, $12, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [processId, d.site_id, d.target_url || '', d.anchor_text || '', d.article_title || '', d.note || '',
                 d.doc_url || '', d.post_url || '', d.insert_after || '', d.insert_statement || '',
                 d.vendor_id, isNicheEdit ? 'insert' : 'insert']
            );

            pushedTasks.push({ root_domain: d.root_domain, vendor_id: d.vendor_id });
        }

        // Update client order status
        await query(
            `UPDATE client_orders SET status = 'pushed_to_blogger', linked_new_order_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [newOrderId, clientOrderId]
        );

        // Send email notifications
        if (send_email && pushedTasks.length > 0) {
            try {
                const grouped = {};
                for (const task of pushedTasks) {
                    if (!grouped[task.vendor_id]) {
                        const userResult = await query('SELECT name, email FROM users WHERE id = $1', [task.vendor_id]);
                        grouped[task.vendor_id] = { email: userResult.rows[0]?.email, name: userResult.rows[0]?.name, tasks: [] };
                    }
                    grouped[task.vendor_id].tasks.push({ root_domain: task.root_domain, order_id: orderId });
                }
                for (const vendorId of Object.keys(grouped)) {
                    const g = grouped[vendorId];
                    if (g.email) sendOrderAssignedEmail(g.email, g.name, g.tasks);
                }
            } catch (emailErr) {
                console.error('Client order email failed (non-blocking):', emailErr.message);
            }
        }

        res.json({
            message: 'Client order pushed to bloggers successfully',
            new_order_id: newOrderId,
            pushed_count: pushedTasks.length
        });
    } catch (error) {
        next(error);
    }
};



/**
 * @route   POST /api/manager/client-orders/:id/send-to-writer
 * @desc    Send client order to writer (creates standard order & assigns to writer)
 * @access  Manager only
 */
const sendClientOrderToWriter = async (req, res, next) => {
    try {
        const clientOrderId = req.params.id;
        const managerId = req.user.id;
        const { writer_id, instructions } = req.body;

        if (!writer_id) {
            return res.status(400).json({ error: 'Writer ID is required' });
        }

        // Verify writer exists and has Writer role
        const writerCheck = await query(
            "SELECT id, role FROM users WHERE id = $1 AND LOWER(role) = 'writer'",
            [writer_id]
        );

        if (writerCheck.rows.length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Invalid writer ID or user is not a writer'
            });
        }

        // Get the client order
        const orderResult = await query(
            `SELECT co.*, u.name as client_name_user 
             FROM client_orders co 
             LEFT JOIN users u ON u.id = co.client_user_id 
             WHERE co.id = $1`,
            [clientOrderId]
        );

        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Client order not found' });
        }

        const clientOrder = orderResult.rows[0];

        if (clientOrder.status !== 'pending_review') {
            return res.status(400).json({ error: 'This order has already been processed' });
        }

        // Get the order details
        const detailsResult = await query(
            `SELECT cod.*, ns.root_domain, ns.uploaded_user_id as vendor_id, ns.gp_price, ns.niche_edit_price
             FROM client_order_details cod 
             LEFT JOIN new_sites ns ON ns.id = cod.site_id 
             WHERE cod.client_order_id = $1`,
            [clientOrderId]
        );

        if (detailsResult.rows.length === 0) {
            return res.status(400).json({ error: 'No sites found in this order' });
        }

        const hasDelegated = detailsResult.rows.some(d => !d.fill_details);
        if (!hasDelegated) {
            return res.status(400).json({ error: 'Only orders containing at least one delegated website can be sent to a writer' });
        }

        // Verify all sites have a vendor/owner
        for (const d of detailsResult.rows) {
            if (!d.vendor_id) {
                return res.status(400).json({
                    error: `Site "${d.root_domain}" does not have an owner. Cannot delegate.`
                });
            }
        }

        const orderId = `CLT-WRT-${clientOrderId}-${Date.now()}`;
        const isNicheEdit = (clientOrder.order_type || '').toLowerCase().includes('niche');

        // Create the standard order task (status: 3 = Assigned to Writer)
        const newOrderResult = await query(
            `INSERT INTO new_orders (manager_id, team_id, order_id, client_name, client_website, no_of_links, order_type, order_package, message, category, new_order_status, type, created_at, updated_at)
             VALUES ($1, 0, $2, $3, '', $4, $5, $6, $7, $8, 3, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`,
            [managerId, orderId, clientOrder.client_name_user || 'Client', detailsResult.rows.length, clientOrder.order_type, clientOrder.order_package || '', instructions || clientOrder.notes || '', clientOrder.category || '']
        );
        const newOrderId = newOrderResult.rows[0].id;

        // Create the process record (status: 3 = Assigned to Writer, with writer_id)
        const processResult = await query(
            `INSERT INTO new_order_processes (new_order_id, team_id, writer_id, manager_id, status, note, statement, created_at, updated_at) 
             VALUES ($1, 0, $2, $3, 3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`,
            [newOrderId, writer_id, managerId, clientOrder.manager_notes || clientOrder.notes || '', instructions || '']
        );
        const processId = processResult.rows[0].id;

        // Create process details for each site
        for (const d of detailsResult.rows) {
            const detailStatus = d.fill_details ? 4 : 3;
            await query(
                `INSERT INTO new_order_process_details 
                 (new_order_process_id, new_site_id, url, anchor, title, note, doc_urls, ourl, insert_after, statement, price, vendor_id, status, type, fill_details, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, $13, $14, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [processId, d.site_id, d.target_url || '', d.anchor_text || '', d.article_title || '', d.note || '',
                 d.doc_url || '', d.post_url || '', d.insert_after || '', d.insert_statement || '',
                 d.vendor_id, detailStatus, isNicheEdit ? 'insert' : 'insert', d.fill_details]
            );
        }

        // Update client order status and link the new_order_id
        await query(
            `UPDATE client_orders SET status = 'sent_to_writer', linked_new_order_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [newOrderId, clientOrderId]
        );

        res.json({
            message: 'Client order delegated to writer successfully',
            new_order_id: newOrderId
        });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getDashboardStats,
    getTasks,
    getTaskById,
    getOrders,
    updateOrder,
    getOrderDetails,
    getPendingFromBloggers,
    getPendingFromTeams,
    getPendingFromWriters,
    getRejectedOrders,
    getRejectedWriterOrders,
    createOrder,
    assignToTeam,
    assignToWriter,
    approveContent,
    approveTeamSubmission,
    rejectTeamSubmission,
    returnToWriter,
    finalizeTask,
    rejectTask,
    getWithdrawals,
    approveWithdrawal,
    rejectWithdrawal,
    getTeamMembers,
    getWriters,
    getBloggers,
    getWebsites,
    pushToBloggers,
    getBloggerSubmissionDetail,
    finalizeFromBlogger,
    rejectBloggerSubmission,
    createOrderChain,
    rejectWriterSubmission,
    getProfile,
    updateProfile,
    uploadProfileImage,
    deleteOrder,
    getClientOrders,
    getClientOrderDetails,
    updateClientOrder,
    rejectClientOrder,
    pushClientOrderToBlogger,
    sendClientOrderToWriter,
    reassignClientOrder
};
