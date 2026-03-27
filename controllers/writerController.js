const Task = require('../models/Task');

/**
 * Writer Controller
 * Handles Writer operations
 */

/**
 * @route   GET /api/writer/tasks
 * @desc    Get tasks assigned to the writer
 * @access  Writer only
 */
const getMyTasks = async (req, res, next) => {
    try {
        const { status } = req.query;

        const filters = { assigned_writer_id: req.user.id };
        if (status) filters.current_status = status;

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
 * @route   GET /api/writer/tasks/:id
 * @desc    Get specific task details
 * @access  Writer only
 */
/**
 * @route   GET /api/writer/tasks/:id
 * @desc    Get specific task details
 * @access  Writer only
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

        // Ensure writer can only view their assigned tasks
        if (String(task.assigned_writer_id) !== String(req.user.id)) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'You can only view tasks assigned to you'
            });
        }

        res.json({ task });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/writer/tasks/:id/submit-content
 * @desc    Submit written content (Batch update, supports file uploads)
 * @access  Writer only
 */
const submitContent = async (req, res, next) => {
    try {
        const { id } = req.params;

        // When sent via FormData, website_submissions may be a JSON string
        let website_submissions = req.body.website_submissions;
        if (typeof website_submissions === 'string') {
            try {
                website_submissions = JSON.parse(website_submissions);
            } catch (e) {
                return res.status(400).json({
                    error: 'Validation Error',
                    message: 'Invalid website_submissions format'
                });
            }
        }

        // Validation
        if (!website_submissions || !Array.isArray(website_submissions) || website_submissions.length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Content submissions are required'
            });
        }

        // Get current task to verify status and assignment
        const task = await Task.findById(id);
        if (!task) {
            return res.status(404).json({ error: 'Not Found', message: 'Task not found' });
        }

        if (String(task.assigned_writer_id) !== String(req.user.id)) {
            return res.status(403).json({ error: 'Forbidden', message: 'This task is not assigned to you' });
        }

        if (task.current_status !== 'ASSIGNED_TO_WRITER' && task.current_status !== 'WRITING_IN_PROGRESS' && task.current_status !== 'REJECTED') {
            return res.status(400).json({
                error: 'Invalid Status',
                message: `Cannot submit content for task with status: ${task.current_status}`
            });
        }

        // Build a map of uploaded files keyed by detail_id
        // Files are sent with fieldname pattern: file_<detail_id>
        const fileMap = {};
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                // fieldname is like "file_123"
                const match = file.fieldname.match(/^file_(\d+)$/);
                if (match) {
                    fileMap[match[1]] = `/uploads/content-files/${file.filename}`;
                }
            }
        }

        // Check if Niche Edit order
        const isNicheEdit = task.order_type?.toLowerCase().includes('niche');

        // Process each submission using new_order_process_details table
        const { query } = require('../config/database');

        for (const submission of website_submissions) {
            const {
                id: detail_id,
                content_link,
                writer_note,
                // Niche Edit fields
                option_type,
                replace_with,
                replace_statement,
                insert_after,
                insert_statement,
                global_note
            } = submission;

            // Get file path for this detail (if uploaded)
            const filePath = fileMap[String(detail_id)] || null;

            if (isNicheEdit) {
                // For Niche Edit orders - save insert_after, statement
                await query(
                    `UPDATE new_order_process_details 
                     SET insert_after = $1, 
                         statement = $2, 
                         note = $3,
                         type = $4,
                         upload_doc_file = COALESCE($5, upload_doc_file),
                         updated_at = CURRENT_TIMESTAMP 
                     WHERE id = $6`,
                    [
                        option_type === 'insert' ? insert_after : replace_with,
                        option_type === 'insert' ? insert_statement : replace_statement,
                        global_note || writer_note || null,
                        option_type || 'replace',
                        filePath,
                        detail_id
                    ]
                );
            } else {
                // For Guest Post orders - save doc_urls, note, and upload_doc_file
                await query(
                    `UPDATE new_order_process_details 
                     SET doc_urls = COALESCE(NULLIF($1, ''), doc_urls), 
                         note = $2,
                         upload_doc_file = COALESCE($3, upload_doc_file),
                         updated_at = CURRENT_TIMESTAMP 
                     WHERE id = $4`,
                    [
                        content_link || null,
                        global_note || writer_note || null,
                        filePath,
                        detail_id
                    ]
                );
            }
        }

        // Update main task status to SUBMITTED_TO_MANAGER
        const updatedTask = await Task.updateStatus(id, 'SUBMITTED_TO_MANAGER');

        res.json({
            message: 'Content submitted successfully and sent for manager review',
            task: updatedTask
        });
    } catch (error) {
        next(error);
    }
};


/**
 * @route   PATCH /api/writer/tasks/:id/mark-in-progress
 * @desc    Mark task as in progress
 * @access  Writer only
 */
const markInProgress = async (req, res, next) => {
    try {
        const { id } = req.params;

        const task = await Task.findById(id);
        if (!task) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Task not found'
            });
        }

        if (String(task.assigned_writer_id) !== String(req.user.id)) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'This task is not assigned to you'
            });
        }

        if (task.current_status !== 'ASSIGNED_TO_WRITER') {
            return res.status(400).json({
                error: 'Invalid Status',
                message: 'Task must be in ASSIGNED_TO_WRITER status'
            });
        }

        const updatedTask = await Task.updateStatus(id, 'WRITING_IN_PROGRESS');

        res.json({
            message: 'Task marked as in progress',
            task: updatedTask
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/writer/dashboard
 * @desc    Get writer dashboard statistics with real data
 * @access  Writer only
 */
const getDashboardStats = async (req, res, next) => {
    try {
        const writerId = req.user.id;
        const { query: dbQuery } = require('../config/database');

        // 1. Completed Orders - unique process IDs where writer submitted work (doc_urls populated)
        const completedResult = await dbQuery(
            `SELECT COUNT(DISTINCT nop.id) as count
             FROM new_order_process_details nopd
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             WHERE nop.writer_id = $1 
               AND nop.status >= 3
               AND ((nopd.doc_urls IS NOT NULL AND nopd.doc_urls != '') 
                 OR (nopd.insert_after IS NOT NULL AND nopd.insert_after != '') 
                 OR (nopd.statement IS NOT NULL AND nopd.statement != '')
                 OR (nopd.upload_doc_file IS NOT NULL AND nopd.upload_doc_file != ''))`,
            [writerId]
        );

        // 2. Order Added Notifications - active tasks currently with writer (status 3)
        // Must check ONLY the latest process record for the order, as historical records may also have status 3
        const ordersAddedResult = await dbQuery(
            `SELECT 
                nop.id,
                no.order_id as manual_order_id,
                no.client_name,
                no.client_website,
                no.order_type,
                nop.created_at
             FROM new_orders no
             JOIN LATERAL (
                 SELECT id, status, writer_id, created_at
                 FROM new_order_processes
                 WHERE new_order_id = no.id
                 ORDER BY id DESC LIMIT 1
             ) nop ON true
             WHERE nop.writer_id = $1 
               AND nop.status = 3
             ORDER BY nop.created_at DESC`,
            [writerId]
        );

        // 3. Rejected Notifications - tasks currently rejected by manager (status 11)
        const rejectedResult = await dbQuery(
            `SELECT 
                nop.id,
                no.order_id as manual_order_id,
                no.client_name,
                no.client_website,
                no.order_type,
                nop.status,
                nop.created_at
             FROM new_orders no
             JOIN LATERAL (
                 SELECT id, status, writer_id, created_at
                 FROM new_order_processes
                 WHERE new_order_id = no.id
                 ORDER BY id DESC LIMIT 1
             ) nop ON true
             WHERE nop.writer_id = $1 
               AND nop.status = 11
             ORDER BY nop.created_at DESC`,
            [writerId]
        );

        // 4. Threads - pending tasks (assigned but not yet submitted)
        // This is essentially the same as active tasks (status 3)
        const threadsResult = await dbQuery(
            `SELECT COUNT(DISTINCT nop.id) as count
             FROM new_orders no
             JOIN LATERAL (
                 SELECT id, status, writer_id
                 FROM new_order_processes
                 WHERE new_order_id = no.id
                 ORDER BY id DESC LIMIT 1
             ) nop ON true
             WHERE nop.writer_id = $1 
               AND nop.status = 3`,
            [writerId]
        );

        res.json({
            stats: {
                completed_orders: parseInt(completedResult.rows[0]?.count || 0),
                order_added_notifications: ordersAddedResult.rows.length,
                rejected_notifications: rejectedResult.rows.length,
                threads: parseInt(threadsResult.rows[0]?.count || 0)
            },
            orders_added_today: ordersAddedResult.rows.map(r => ({
                id: r.id,
                manual_order_id: r.manual_order_id || `ORD-${r.id}`,
                client_name: r.client_name,
                client_website: r.client_website,
                order_type: r.order_type,
                created_at: r.created_at
            })),
            rejected_orders: rejectedResult.rows.map(r => ({
                id: r.id,
                manual_order_id: r.manual_order_id || `ORD-${r.id}`,
                client_name: r.client_name,
                client_website: r.client_website,
                order_type: r.order_type,
                current_status: 'REJECTED',
                created_at: r.created_at
            }))
        });
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        next(error);
    }
};

/**
 * @route   GET /api/writer/completed-orders
 * @desc    Get completed orders for the writer (orders pushed to manager)
 * @access  Writer only
 */
const getCompletedOrders = async (req, res, next) => {
    try {
        const writerId = req.user.id;
        const { query: dbQuery } = require('../config/database');

        // Query UNIQUE ORDERS (by nop.id) where:
        // 1. writer_id = logged in writer
        // 2. nop.status >= 3 (assigned to writer or further)
        // 3. At least one detail with doc_urls populated (writer submitted work)
        // This matches production's count (~358 for Dhruv = 330 unique process IDs)
        const result = await dbQuery(
            `SELECT DISTINCT ON (nop.id)
                nop.id as process_id,
                nop.new_order_id as order_id,
                nop.status as process_status,
                nop.writer_id,
                nop.created_at as assigned_date,
                nop.updated_at as pushed_date,
                no.order_id as manual_order_id,
                no.client_name,
                no.client_website,
                no.order_type,
                no.category,
                no.message as notes,
                no.created_at as order_created_at,
                m.name as manager_name,
                m.email as manager_email
             FROM new_order_process_details nopd
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             JOIN new_orders no ON nop.new_order_id = no.id
             LEFT JOIN users m ON no.manager_id = m.id
             WHERE nop.writer_id = $1 
               AND nop.status >= 3
               AND ((nopd.doc_urls IS NOT NULL AND nopd.doc_urls != '') 
                 OR (nopd.insert_after IS NOT NULL AND nopd.insert_after != '') 
                 OR (nopd.statement IS NOT NULL AND nopd.statement != '')
                 OR (nopd.upload_doc_file IS NOT NULL AND nopd.upload_doc_file != ''))
             ORDER BY nop.id DESC, nop.updated_at DESC`,
            [writerId]
        );

        res.json({
            count: result.rows.length,
            orders: result.rows.map(row => ({
                id: row.process_id,
                order_id: row.order_id,
                manual_order_id: row.manual_order_id || `ORD-${row.order_id}`,
                manager_name: row.manager_name || '-',
                order_type: row.order_type || 'GP',
                pushed_date: row.pushed_date || row.assigned_date,
                created_at: row.order_created_at,
                client_name: row.client_name,
                client_website: row.client_website,
                category: row.category,
                status: row.process_status >= 5 ? 'Completed' : 'Submitted'
            }))
        });
    } catch (error) {
        console.error('Error fetching completed orders:', error);
        next(error);
    }
};

/**
 * @route   GET /api/writer/completed-orders/:id
 * @desc    Get specific completed order detail for writer (by process_id)
 * @access  Writer only
 */
const getCompletedOrderDetail = async (req, res, next) => {
    try {
        const writerId = req.user.id;
        const processId = req.params.id;
        const { query: dbQuery } = require('../config/database');

        // First get the process info
        const processResult = await dbQuery(
            `SELECT 
                nop.id as process_id,
                nop.new_order_id as order_id,
                nop.status as process_status,
                nop.writer_id,
                nop.created_at as manager_pushed_date,
                nop.updated_at as writer_pushed_date,
                no.order_id as manual_order_id,
                no.client_name,
                no.client_website,
                no.order_type,
                no.category,
                no.message as order_notes,
                no.created_at as order_created_at,
                m.name as manager_name,
                m.email as manager_email
             FROM new_order_processes nop
             JOIN new_orders no ON nop.new_order_id = no.id
             LEFT JOIN users m ON no.manager_id = m.id
             WHERE nop.id = $1 AND nop.writer_id = $2`,
            [processId, writerId]
        );

        if (processResult.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Completed order not found or not accessible'
            });
        }

        const process = processResult.rows[0];

        // Then get all detail rows for this process
        const detailsResult = await dbQuery(
            `SELECT 
                nopd.id as detail_id,
                nopd.url as target_url,
                nopd.ourl as post_url,
                nopd.anchor,
                nopd.title,
                nopd.note,
                nopd.doc_urls,
                nopd.upload_doc_file,
                nopd.insert_after,
                nopd.statement,
                nopd.type as niche_type,
                nopd.status as detail_status,
                nopd.created_at as detail_created_at,
                nopd.updated_at as detail_updated_at,
                ns.root_domain as website_domain
             FROM new_order_process_details nopd
             LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
             WHERE nopd.new_order_process_id = $1
             ORDER BY nopd.id ASC`,
            [processId]
        );

        res.json({
            order: {
                id: process.process_id,
                order_id: process.order_id,
                manual_order_id: process.manual_order_id || `ORD-${process.order_id}`,
                manager_name: process.manager_name || '-',
                order_type: process.order_type || 'GP',
                manager_pushed_date: process.manager_pushed_date,
                writer_pushed_date: process.writer_pushed_date,
                created_at: process.order_created_at,
                client_name: process.client_name,
                client_website: process.client_website,
                category: process.category,
                order_notes: process.order_notes,
                status: process.process_status >= 5 ? 'Completed' : 'Submitted',
                // All detail rows for this order
                details: detailsResult.rows.map(d => ({
                    id: d.detail_id,
                    root_domain: d.website_domain,
                    url: d.target_url,
                    post_url: d.post_url,
                    anchor: d.anchor,
                    title: d.title,
                    note: d.note,
                    doc_urls: d.doc_urls,
                    upload_doc_file: d.upload_doc_file,
                    insert_after: d.insert_after,
                    statement: d.statement,
                    niche_type: d.niche_type,
                    status: d.detail_status,
                    created_at: d.detail_created_at,
                    updated_at: d.detail_updated_at
                }))
            }
        });
    } catch (error) {
        console.error('Error fetching completed order detail:', error);
        next(error);
    }
};
// ==================== PROFILE MANAGEMENT ====================

/**
 * @route   GET /api/writer/profile
 * @desc    Get current writer's profile
 * @access  Writer only
 */
const getProfile = async (req, res, next) => {
    try {
        const { query: dbQuery } = require('../config/database');
        const result = await dbQuery(
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
 * @route   PUT /api/writer/profile
 * @desc    Update current writer's profile
 * @access  Writer only
 */
const updateProfile = async (req, res, next) => {
    try {
        const { name, gender, mobile } = req.body;
        const { query: dbQuery } = require('../config/database');

        if (!name || !name.trim()) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Name is required'
            });
        }

        await dbQuery(
            `UPDATE users SET name = $1, gender = $2, mobile_number = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
            [name.trim(), gender || null, mobile || null, req.user.id]
        );

        res.json({ message: 'Profile updated successfully' });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/writer/profile/image
 * @desc    Upload writer profile image
 * @access  Writer only
 */
const uploadProfileImage = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'No image file provided'
            });
        }

        const { query: dbQuery } = require('../config/database');
        const imagePath = `/uploads/profiles/${req.file.filename}`;

        await dbQuery(
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
 * @route   POST /api/writer/tasks/:id/reject
 * @desc    Writer rejects an assigned task with a reason
 * @access  Writer only
 */
const rejectTask = async (req, res, next) => {
    try {
        const { id } = req.params; // This is the order id (new_orders.id)
        const { reject_reason } = req.body;
        const writerId = req.user.id;

        if (!reject_reason || reject_reason.trim().length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Rejection reason is required'
            });
        }

        // Get the task to verify ownership
        const task = await Task.findById(id);
        if (!task) {
            return res.status(404).json({ error: 'Not Found', message: 'Task not found' });
        }

        if (String(task.assigned_writer_id) !== String(writerId)) {
            return res.status(403).json({ error: 'Forbidden', message: 'This task is not assigned to you' });
        }

        if (task.current_status !== 'ASSIGNED_TO_WRITER' && task.current_status !== 'WRITING_IN_PROGRESS') {
            return res.status(400).json({
                error: 'Invalid Status',
                message: `Cannot reject task with status: ${task.current_status}`
            });
        }

        const { query: dbQuery } = require('../config/database');

        // Get the latest process for this order
        const processResult = await dbQuery(
            `SELECT id FROM new_order_processes WHERE new_order_id = $1 ORDER BY id DESC LIMIT 1`,
            [id]
        );

        if (processResult.rows.length === 0) {
            return res.status(404).json({ error: 'Not Found', message: 'Process not found for this order' });
        }

        const processId = processResult.rows[0].id;

        // Update process status to 11 (Rejected) and save reason in note column
        await dbQuery(
            `UPDATE new_order_processes 
             SET status = 11, note = $1, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $2`,
            [reject_reason.trim(), processId]
        );

        // Also update the order-level status
        await dbQuery(
            `UPDATE new_orders SET new_order_status = 11, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [id]
        );

        res.json({
            message: 'Order rejected successfully',
            order_id: id,
            reject_reason: reject_reason.trim()
        });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getMyTasks,
    getTaskById,
    submitContent,
    markInProgress,
    getDashboardStats,
    getCompletedOrders,
    getCompletedOrderDetail,
    getProfile,
    updateProfile,
    uploadProfileImage,
    rejectTask
};

