const Task = require('../models/Task');
const Website = require('../models/Website');
const { query } = require('../config/database');

/**
 * Team Controller - Production Database Compatible
 * Handles Team/Researcher operations
 * WORKFLOW STEP 2: Team selects websites & submits back to Manager
 * 
 * Production Schema:
 * - tasks → new_orders + new_order_processes
 * - websites → new_sites
 */

/**
 * @route   GET /api/team/tasks
 * @desc    Get tasks assigned to the team member
 * @access  Team only
 */
const getMyTasks = async (req, res, next) => {
    try {
        // Get tasks either created by or assigned to this team member
        const tasks = await Task.findAll({ assigned_team_id: req.user.id });

        res.json({
            count: tasks.length,
            tasks
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/team/assigned
 * @desc    Get tasks assigned from Manager (pending action)
 * @access  Team only
 */
const getAssignedTasks = async (req, res, next) => {
    try {
        // Use Task.findAll with status filter
        const allTasks = await Task.findAll({ assigned_team_id: req.user.id });
        const tasks = allTasks.filter(t =>
            t.current_status === 'PENDING_MANAGER_APPROVAL_1' ||
            t.current_status === 'DRAFT'
        );

        res.json({
            count: tasks.length,
            tasks
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/team/tasks/:id/submit-website
 * @desc    WORKFLOW STEP 2: Team selects website and submits back to Manager
 * @access  Team only
 */
const submitWebsite = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { website_id, notes, suggested_topic_url } = req.body;

        // Validation
        if (!website_id) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Website ID is required'
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

        // Ensure team member owns this task
        if (String(task.assigned_team_id) !== String(req.user.id)) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'You can only submit for your own assigned tasks'
            });
        }

        // Verify website exists
        const website = await Website.findById(website_id);
        if (!website) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Invalid website ID'
            });
        }

        // Submit website selection to manager
        const updatedTask = await Task.teamSubmitWebsite(id, website_id, notes);

        // Also update suggested_topic_url if provided
        if (suggested_topic_url) {
            await Task.updateStatus(id, task.current_status, {
                suggested_topic_url
            });
        }

        res.json({
            message: 'Website submitted for manager approval',
            task: updatedTask
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/team/tasks
 * @desc    Create new task (research submission - legacy support)
 * @access  Team only
 */
const createTask = async (req, res, next) => {
    try {
        const { suggested_topic_url, website_id, notes } = req.body;

        // Validation
        if (!suggested_topic_url) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Suggested topic URL is required'
            });
        }

        const task = await Task.create({
            suggested_topic_url,
            website_id,
            created_by: req.user.id,
            assigned_team_id: req.user.id,
            notes
        });

        res.status(201).json({
            message: 'Task created successfully and sent for manager approval',
            task
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/team/tasks/:id
 * @desc    Get specific task details
 * @access  Team only
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

        // Ensure team member can view their tasks
        if (String(task.created_by) !== String(req.user.id) && String(task.assigned_team_id) !== String(req.user.id)) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'You can only view your own tasks'
            });
        }

        res.json({ task });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/team/websites
 * @desc    Get available websites for selection with filters
 * @access  Team only
 * 
 * Query params:
 * - page, limit: pagination
 * - domain: filter by root_domain (partial match)
 * - traffic: filter by minimum traffic value
 * - category: filter by category (partial match)
 */
const getWebsites = async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        // Filter parameters
        const domainFilter = req.query.domain || '';
        const trafficFilter = req.query.traffic ? parseInt(req.query.traffic) : null;
        const categoryFilter = req.query.category || '';

        // Build WHERE conditions
        let whereConditions = [`(ns.delete_site IS NULL OR ns.delete_site = 0)`, `ns.site_status = '1'`];
        let params = [];
        let paramIndex = 1;

        if (domainFilter) {
            whereConditions.push(`ns.root_domain ILIKE $${paramIndex}`);
            params.push(`%${domainFilter}%`);
            paramIndex++;
        }

        if (trafficFilter) {
            whereConditions.push(`CAST(NULLIF(REGEXP_REPLACE(ns.traffic_source, '[^0-9]', '', 'g'), '') AS INTEGER) >= $${paramIndex}`);
            params.push(trafficFilter);
            paramIndex++;
        }

        if (categoryFilter) {
            whereConditions.push(`ns.category ILIKE $${paramIndex}`);
            params.push(`%${categoryFilter}%`);
            paramIndex++;
        }

        const whereClause = whereConditions.join(' AND ');

        // Get total count with filters
        const countResult = await query(
            `SELECT COUNT(*) as total FROM new_sites ns WHERE ${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(total / limit);

        // Get paginated sites with filters
        const result = await query(
            `SELECT ns.id, ns.root_domain, ns.niche, ns.category, 
                    ns.da, ns.dr, ns.rd, ns.spam_score, ns.traffic_source as traffic, 
                    ns.gp_price, ns.niche_edit_price as niche_price, ns.deal_cbd_casino,
                    ns.email, ns.site_status, ns.website_status,
                    ns.fc_gp, ns.fc_ne, ns.website_niche, ns.sample_url, ns.href_url,
                    ns.paypal_id, ns.skype, ns.whatsapp, ns.country_source,
                    ns.created_at, ns.updated_at,
                    (SELECT MAX(nopd.created_at) FROM new_order_process_details nopd WHERE nopd.new_site_id = ns.id) as lo_created_at
             FROM new_sites ns
             WHERE ${whereClause}
             ORDER BY ns.created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            [...params, limit, offset]
        );

        res.json({
            sites: result.rows,
            pagination: {
                page,
                limit,
                total,
                totalPages
            },
            filters: {
                domain: domainFilter,
                traffic: trafficFilter,
                category: categoryFilter
            }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/team/dashboard
 * @desc    Get dashboard stats for Team member
 * @access  Team only
 */
const getDashboardStats = async (req, res, next) => {
    try {
        const teamId = req.user.id;

        // 1. Completed orders = unique process IDs where team added sites
        const completedResult = await query(
            `SELECT COUNT(DISTINCT nop.id) as count
             FROM new_order_process_details nopd
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             WHERE nop.team_id = $1 
               AND nopd.new_site_id IS NOT NULL`,
            [teamId]
        );

        // Get all tasks for this team (used for multiple counts)
        const allTasks = await Task.findAll({ assigned_team_id: teamId });

        // 2. Order Added Notifications = DRAFT tasks without website_id (matches getOrderNotifications)
        const orderNotifications = allTasks.filter(t =>
            t.current_status === 'DRAFT' && !t.website_id
        );

        // 3. Rejected Notifications = REJECTED or RETURNED tasks
        const rejectedTasks = allTasks.filter(t =>
            t.current_status === 'REJECTED' ||
            t.current_status === 'RETURNED_FROM_MANAGER'
        );

        // 4. Threads count
        const threadsResult = await query(
            `SELECT COUNT(*) as count
             FROM threads
             WHERE user_id = $1`,
            [teamId]
        );

        // Get active websites count
        const websiteCount = await query(`
            SELECT COUNT(*) as count FROM new_sites WHERE site_status = 'Active'
        `);

        // Today's date
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Orders added today
        const ordersAddedToday = allTasks.filter(t => {
            const taskDate = new Date(t.created_at);
            return taskDate >= today;
        });

        const stats = {
            completed_tasks: parseInt(completedResult.rows[0]?.count || 0),
            pending_tasks: orderNotifications.length,
            rejected_tasks: rejectedTasks.length,
            total_tasks: parseInt(threadsResult.rows[0]?.count || 0),
            available_websites: parseInt(websiteCount.rows[0]?.count || 0)
        };

        res.json({
            stats,
            orders_added_today: ordersAddedToday.map(t => ({
                id: t.id,
                manual_order_id: t.manual_order_id,
                client_name: t.client_name,
                client_website: t.client_website,
                order_type: t.order_type,
                created_at: t.created_at
            })),
            rejected_orders: rejectedTasks.map(t => ({
                id: t.id,
                manual_order_id: t.manual_order_id,
                client_name: t.client_name,
                client_website: t.client_website,
                order_type: t.order_type,
                current_status: t.current_status,
                created_at: t.created_at
            }))
        });
    } catch (error) {
        console.error('Error in getDashboardStats:', error);
        next(error);
    }
};

/**
 * @route   POST /api/team/websites
 * @desc    Add a new website to the system
 * @access  Team only
 */
const addWebsite = async (req, res, next) => {
    try {
        const { domain_url, category, dr, da, traffic, rd, niche_price, gp_price, status } = req.body;

        // Validation
        if (!domain_url) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Domain URL is required'
            });
        }

        // Create website using Website model (uses new_sites table)
        const website = await Website.create({
            domain_url,
            category: category || 'General',
            dr: dr || null,
            da: da || null,
            traffic: traffic || null,
            rd: rd || null,
            niche_price: niche_price || null,
            gp_price: gp_price || null,
            status: status || 'Active',
            added_by: req.user.id
        });

        res.status(201).json({
            message: 'Website added successfully',
            website
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/team/order-notifications
 * @desc    Get orders pushed by Manager that team hasn't worked on yet (DRAFT only)
 * @access  Team only
 */
const getOrderNotifications = async (req, res, next) => {
    try {
        // Get tasks assigned to this team member that are still in DRAFT status
        // DRAFT = manager assigned order but team hasn't pushed yet
        // Once team pushes to manager, status becomes 2 (PENDING_MANAGER_APPROVAL_1)
        const allTasks = await Task.findAll({ assigned_team_id: req.user.id });
        const orders = allTasks.filter(t =>
            t.current_status === 'DRAFT' && !t.website_id
        );

        res.json({
            count: orders.length,
            orders
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/team/order-notifications/:id
 * @desc    Get specific order details for Push to Manager page
 * @access  Team only
 */
const getTaskForPush = async (req, res, next) => {
    try {
        const { id } = req.params;

        const task = await Task.findById(id);

        if (!task || !task.assigned_team_id) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Task not found or not assigned to any team member'
            });
        }

        res.json({ task });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/team/order-notifications/:id/submit
 * @desc    Submit selected websites for an order (batch submission)
 * @access  Team only
 */
const submitWebsitesToManager = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { website_ids, notes, website_data } = req.body;

        // Validation
        if (!website_ids || !Array.isArray(website_ids) || website_ids.length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'At least one website must be selected'
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

        // Allow any team member to submit for tasks that have a team assigned
        if (!task.assigned_team_id) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'This task is not assigned to any team member'
            });
        }

        // Get or create new_order_process record
        let processId = task.process_id;
        console.log('==== SUBMIT WEBSITES TO MANAGER ====');
        console.log('Task ID:', id);
        console.log('Process ID from task:', processId);
        console.log('Website IDs:', website_ids);
        console.log('Website Data:', website_data);

        if (!processId) {
            // Create new_order_process
            const processResult = await query(
                `INSERT INTO new_order_processes (new_order_id, team_id, manager_id, status, created_at, updated_at)
                 VALUES ($1, $2, $3, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 RETURNING id`,
                [id, task.assigned_team_id, task.manager_id]
            );
            processId = processResult.rows[0].id;
            console.log('Created new process ID:', processId);
        } else {
            // Update existing process status
            await query(
                `UPDATE new_order_processes SET status = 2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [processId]
            );
            console.log('Updated existing process ID:', processId);
        }

        // Delete existing process details for this order (if resubmitting)
        const deleteResult = await query(`DELETE FROM new_order_process_details WHERE new_order_process_id = $1`, [processId]);
        console.log('Deleted existing details, rows affected:', deleteResult.rowCount);

        // Insert each selected website into new_order_process_details
        console.log('Inserting', website_ids.length, 'websites...');
        for (let i = 0; i < website_ids.length; i++) {
            const websiteId = website_ids[i];
            // Get website data if provided (contains notes, copyUrl)
            const siteData = website_data ? website_data.find(w => w.id == websiteId || w.website_id == websiteId) : null;
            console.log(`Inserting website ${i + 1}: websiteId=${websiteId}`);
            console.log(`  siteData:`, JSON.stringify(siteData));
            console.log(`  note: "${siteData?.note || ''}"`);
            console.log(`  copyUrl: "${siteData?.copyUrl || ''}"`);

            const insertResult = await query(
                `INSERT INTO new_order_process_details 
                 (new_order_process_id, new_site_id, note, doc_urls, ourl, price, created_at, updated_at, status)
                 VALUES ($1, $2, $3, $4, $5, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 2)
                 RETURNING id`,
                [processId, websiteId, siteData?.note || null, siteData?.copyUrl || null, siteData?.copyUrl || null]
            );
            console.log(`Inserted detail ID: ${insertResult.rows[0]?.id}`);
        }

        // Update task status to PENDING_MANAGER_APPROVAL_1
        const updatedTask = await Task.updateStatus(id, 'PENDING_MANAGER_APPROVAL_1', {
            notes: notes || null
        });

        res.json({
            message: 'Websites submitted to Manager for approval',
            task: updatedTask,
            submitted_websites: website_ids.length
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/team/completed-orders
 * @desc    Get completed orders for team - orders where team has added sites
 * @access  Team only
 * Team "completed" = all orders where they have added websites (new_site_id populated in details)
 */
const getCompletedOrders = async (req, res, next) => {
    try {
        const teamId = req.user.id;

        // Query unique orders where team has added sites
        // Team's work is complete when they've added sites to the order details
        const result = await query(
            `SELECT DISTINCT ON (nop.id)
                nop.id as process_id,
                nop.new_order_id as order_db_id,
                nop.team_id,
                nop.status,
                nop.created_at as assigned_date,
                nop.updated_at as pushed_date,
                no.order_id,
                no.client_name,
                no.client_website,
                no.no_of_links,
                no.order_type,
                no.order_package,
                no.category,
                no.message as notes,
                no.created_at,
                m.name as manager_name,
                m.id as manager_id,
                t.name as team_name
            FROM new_order_process_details nopd
            JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
            JOIN new_orders no ON nop.new_order_id = no.id
            LEFT JOIN users m ON nop.manager_id = m.id
            LEFT JOIN users t ON nop.team_id = t.id
            WHERE nop.team_id = $1 
              AND nopd.new_site_id IS NOT NULL
            ORDER BY nop.id DESC, nop.updated_at DESC
            LIMIT 2000`,
            [teamId]
        );

        // Map status to readable string
        const statusMap = {
            1: 'Draft',
            2: 'Pending Manager',
            3: 'Assigned to Writer',
            4: 'Writer Submitted',
            5: 'Completed',
            8: 'Credited',
            11: 'Rejected'
        };

        const orders = result.rows.map(row => ({
            id: row.process_id,
            order_id: row.order_id || `ORD-${row.order_db_id}`,
            client_name: row.client_name,
            client_website: row.client_website,
            no_of_links: row.no_of_links,
            order_type: row.order_type,
            order_package: row.order_package,
            category: row.category,
            notes: row.notes,
            manager_id: row.manager_id,
            manager_name: row.manager_name || '-',
            team_name: row.team_name,
            current_status: statusMap[row.status] || 'Unknown',
            assigned_date: row.assigned_date,
            pushed_date: row.pushed_date,
            created_at: row.created_at
        }));

        res.json({
            count: orders.length,
            orders
        });
    } catch (error) {
        console.error('Error fetching completed orders:', error);
        next(error);
    }
};

/**
 * @route   GET /api/team/completed-orders/:id
 * @desc    Get detailed order information for team completed order detail page
 * @access  Team only
 * Returns: Order info, message, timeline of team submissions and manager responses
 */
const getCompletedOrderDetail = async (req, res, next) => {
    try {
        const teamId = req.user.id;
        const processId = req.params.id;

        // 1. Get order process info with order details
        const orderResult = await query(
            `SELECT 
                nop.id as process_id,
                nop.status,
                nop.created_at as order_assigned_date,
                nop.updated_at,
                nop.team_id,
                nop.manager_id,
                no.id as order_id,
                no.order_id as manual_order_id,
                no.client_name,
                no.client_website,
                no.no_of_links,
                no.order_type,
                no.order_package,
                no.category,
                no.message,
                no.created_at as order_created_at,
                m.name as manager_name,
                m.email as manager_email,
                t.name as team_name,
                t.email as team_email
            FROM new_order_processes nop
            JOIN new_orders no ON nop.new_order_id = no.id
            LEFT JOIN users m ON nop.manager_id = m.id
            LEFT JOIN users t ON nop.team_id = t.id
            WHERE nop.id = $1 AND nop.team_id = $2`,
            [processId, teamId]
        );

        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const order = orderResult.rows[0];

        // 2. Get all detail entries (sites submitted by team)
        const detailsResult = await query(
            `SELECT 
                nopd.id as detail_id,
                nopd.new_site_id,
                nopd.url,
                nopd.submit_url,
                nopd.price,
                nopd.anchor,
                nopd.title,
                nopd.note,
                nopd.doc_urls,
                nopd.created_at as submitted_at,
                nopd.updated_at,
                ns.root_domain,
                ns.niche_edit_price,
                ns.gp_price,
                ns.dr,
                ns.da,
                ns.traffic
            FROM new_order_process_details nopd
            LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
            WHERE nopd.new_order_process_id = $1
            ORDER BY nopd.created_at ASC`,
            [processId]
        );

        // 3. Get rejection history (if any) - wrapped in try-catch as table may not exist
        let rejectionsResult = { rows: [] };
        try {
            rejectionsResult = await query(
                `SELECT 
                    id,
                    note as rejection_note,
                    created_at as rejected_at
                FROM team_rejections
                WHERE new_order_process_id = $1
                ORDER BY created_at ASC`,
                [processId]
            );
        } catch (err) {
            // Table may not exist - ignore error
            console.log('team_rejections table not found, skipping rejections');
        }

        // Map status to readable string
        const statusMap = {
            1: 'Draft',
            2: 'Pending Manager',
            3: 'Assigned to Writer',
            4: 'Writer Submitted',
            5: 'Completed',
            8: 'Credited',
            11: 'Rejected'
        };

        // Group details by submission timestamp (to show multiple pushes)
        const detailsByTimestamp = {};
        detailsResult.rows.forEach(detail => {
            const timestamp = detail.submitted_at ? new Date(detail.submitted_at).toISOString() : 'pending';
            if (!detailsByTimestamp[timestamp]) {
                detailsByTimestamp[timestamp] = [];
            }

            // Use price from detail or calculate from site prices
            const price = detail.price || (order.order_type === 'niche' || order.order_type === 'Niche Edit'
                ? detail.niche_edit_price
                : detail.gp_price);

            detailsByTimestamp[timestamp].push({
                id: detail.detail_id,
                root_domain: detail.root_domain || '-',
                price: price || '-',
                url: detail.submit_url || detail.url || '-',
                anchor: detail.anchor || '-',
                title: detail.title || '-',
                note: detail.note || '',
                doc_urls: detail.doc_urls || '',
                dr: detail.dr,
                da: detail.da,
                traffic: detail.traffic
            });
        });

        // Build timeline events
        const timeline = [];

        // Add "New Order Created" event
        timeline.push({
            type: 'order_created',
            timestamp: order.order_assigned_date,
            title: 'New Order Created',
            description: `Order Assigned to Team: ${order.team_name} (${order.team_email})`
        });

        // Add submissions as "Team Pushed to Manager" events
        Object.keys(detailsByTimestamp).sort().forEach(ts => {
            if (ts !== 'pending') {
                timeline.push({
                    type: 'team_pushed',
                    timestamp: ts,
                    title: 'Team Pushed to Manager',
                    sites: detailsByTimestamp[ts],
                    note: detailsByTimestamp[ts][0]?.note || 'Done'
                });
            }
        });

        // Add rejections as "Manager Disapproved" events
        rejectionsResult.rows.forEach(rejection => {
            timeline.push({
                type: 'manager_rejected',
                timestamp: rejection.rejected_at,
                title: 'Manager Disapproved Team Post',
                note: rejection.rejection_note || 'Rejected'
            });
        });

        // Sort timeline by timestamp
        timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        res.json({
            order: {
                process_id: order.process_id,
                order_id: order.manual_order_id || `ORD-${order.order_id}`,
                status: statusMap[order.status] || 'Unknown',
                status_code: order.status,
                client_name: order.client_name,
                client_website: order.client_website,
                no_of_links: order.no_of_links,
                order_type: order.order_type,
                order_package: order.order_package,
                category: order.category,
                message: order.message,
                manager_name: order.manager_name,
                team_name: order.team_name,
                order_created_at: order.order_created_at,
                order_assigned_date: order.order_assigned_date
            },
            timeline,
            total_sites: detailsResult.rows.length
        });
    } catch (error) {
        console.error('Error fetching completed order detail:', error);
        next(error);
    }
};

/**
 * @route   GET /api/team/rejected-links
 * @desc    Get rejected links/orders
 * @access  Team only
 */
const getRejectedLinks = async (req, res, next) => {
    try {
        const orders = await Task.findAll({
            assigned_team_id: req.user.id,
            current_status: 'REJECTED'
        });

        res.json({
            count: orders.length,
            orders
        });
    } catch (error) {
        next(error);
    }
};

// ==================== THREADS ====================

/**
 * @route   GET /api/team/managers
 * @desc    Get list of managers for thread creation
 * @access  Team only
 */
const getManagers = async (req, res, next) => {
    try {
        const result = await query(
            `SELECT id, name, email FROM users 
             WHERE role = 'manager' AND name NOT LIKE '%REWARD%'
             ORDER BY name ASC`
        );
        res.json({ managers: result.rows });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/team/threads
 * @desc    Get threads for current team member
 * @access  Team only
 */
const getThreads = async (req, res, next) => {
    try {
        const result = await query(
            `SELECT t.*, u.name as user_name,
                    (SELECT COUNT(*) FROM thread_messages m WHERE m.thread_id = t.id) as message_count
             FROM threads t
             LEFT JOIN users u ON t.user_id = u.id
             WHERE t.owner_id = $1
             ORDER BY t.created_at DESC`,
            [req.user.id]
        );
        res.json({ threads: result.rows });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/team/threads
 * @desc    Create a new thread to a manager
 * @access  Team only
 */
const createThread = async (req, res, next) => {
    try {
        const { user_id, subject } = req.body;

        if (!user_id || !subject) {
            return res.status(400).json({ message: 'User ID and subject are required' });
        }

        const result = await query(
            `INSERT INTO threads (owner_id, user_id, subject, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())
             RETURNING *`,
            [req.user.id, user_id, subject]
        );

        res.status(201).json({
            message: 'Thread created successfully',
            thread: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/team/threads/:id/messages
 * @desc    Get messages for a thread
 * @access  Team only
 */
const getThreadMessages = async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(
            `SELECT m.*, u.name as sender_name
             FROM thread_messages m
             LEFT JOIN users u ON m.user_id = u.id
             WHERE m.thread_id = $1
             ORDER BY m.created_at ASC`,
            [id]
        );

        res.json({ messages: result.rows });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/team/threads/:id/messages
 * @desc    Send a message in a thread
 * @access  Team only
 */
const sendMessage = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({ message: 'Message is required' });
        }

        const result = await query(
            `INSERT INTO thread_messages (thread_id, user_id, message, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())
             RETURNING *`,
            [id, req.user.id, message]
        );

        res.status(201).json({
            message: 'Message sent successfully',
            data: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

// ==================== PROFILE MANAGEMENT ====================

/**
 * @route   GET /api/team/profile
 * @desc    Get current team member's profile
 * @access  Team only
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
 * @route   PUT /api/team/profile
 * @desc    Update current team member's profile
 * @access  Team only
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
 * @route   POST /api/team/profile/image
 * @desc    Upload team member profile image
 * @access  Team only
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
 * @route   GET /api/team/permissions
 * @desc    Get team member's permissions
 * @access  Team only
 */
const getMyPermissions = async (req, res, next) => {
    try {
        const userId = req.user.id;

        const result = await query(
            'SELECT permissions FROM users WHERE id = $1',
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const userPermissionsStr = result.rows[0].permissions;

        // Parse JSONB permissions or default to empty object
        const permissions = typeof userPermissionsStr === 'string'
            ? JSON.parse(userPermissionsStr || '{}')
            : (userPermissionsStr || {});

        res.json({ permissions });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getMyTasks,
    getAssignedTasks,
    submitWebsite,
    createTask,
    getTaskById,
    getWebsites,
    getDashboardStats,
    addWebsite,
    getOrderNotifications,
    getTaskForPush,
    submitWebsitesToManager,
    getCompletedOrders,
    getCompletedOrderDetail,
    getRejectedLinks,
    getManagers,
    getThreads,
    createThread,
    getThreadMessages,
    sendMessage,
    getProfile,
    updateProfile,
    uploadProfileImage,
    getMyPermissions
};

