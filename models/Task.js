const { query, transaction } = require('../config/database');

/**
 * Task Model - Production Database Compatible
 * Core entity managing the entire workflow lifecycle
 * 
 * Production schema mapping:
 * - tasks → new_orders (main order info)
 * - workflow states → new_order_processes (status tracking per order)
 * - site/vendor assignments → new_order_process_details (detail records)
 * 
 * Workflow: Manager → Team → Manager → Writer → Manager → Blogger (vendor) → Credits
 * 
 * Status codes in new_order_processes:
 * 1 = Created/Pending Team
 * 2 = Team Submitted to Manager  
 * 3 = Assigned to Writer
 * 4 = Writer Submitted Content
 * 5 = Assigned to Vendor (Blogger) / Completed
 * 11 = Rejected
 */

// Status mapping between app workflow and production database
const STATUS_MAP = {
    'DRAFT': 1,
    'PENDING_MANAGER_APPROVAL_1': 2,  // Team submitted, waiting for manager
    'ASSIGNED_TO_WRITER': 3,
    'WRITING_IN_PROGRESS': 3,
    'PENDING_MANAGER_APPROVAL_2': 4,  // Writer submitted content
    'SUBMITTED_TO_MANAGER': 4,
    'ASSIGNED_TO_BLOGGER': 5,
    'PENDING_FINAL_CHECK': 5,
    'COMPLETED': 5,
    'CREDITED': 5,
    'REJECTED': 11
};

const STATUS_MAP_REVERSE = {
    1: 'DRAFT',
    2: 'PENDING_MANAGER_APPROVAL_1',
    3: 'ASSIGNED_TO_WRITER',
    4: 'PENDING_MANAGER_APPROVAL_2',
    5: 'ASSIGNED_TO_BLOGGER',
    11: 'REJECTED'
};

class Task {
    /**
     * Convert database status to app status
     */
    static mapStatus(dbStatus, hasWriter, hasVendor, hasSubmitUrl) {
        if (dbStatus === 5) {
            if (hasSubmitUrl) return 'CREDITED';
            if (hasVendor) return 'ASSIGNED_TO_BLOGGER';
            return 'COMPLETED';
        }
        if (dbStatus === 4) return 'PENDING_MANAGER_APPROVAL_2';
        if (dbStatus === 3) return hasWriter ? 'WRITING_IN_PROGRESS' : 'ASSIGNED_TO_WRITER';
        if (dbStatus === 2) return 'PENDING_MANAGER_APPROVAL_1';
        if (dbStatus === 1) return 'DRAFT';
        if (dbStatus === 11) return 'REJECTED';
        return STATUS_MAP_REVERSE[dbStatus] || 'DRAFT';
    }

    /**
     * Get all tasks/orders with filters
     */
    static async findAll(filters = {}) {
        let sql = `
            SELECT 
                o.id,
                o.order_id as manual_order_id,
                o.manager_id,
                o.team_id as assigned_team_id,
                o.client_name,
                o.client_website,
                o.no_of_links,
                o.order_type,
                o.order_package,
                o.message as notes,
                o.category,
                o.new_order_status,
                o.type,
                o.fc,
                o.completed_tasks,
                o.created_at,
                o.updated_at,
                m.name as manager_name,
                t.name as team_name,
                nop.status as process_status,
                nop.writer_id as assigned_writer_id,
                w.name as writer_name,
                w.email as writer_email,
                nopd.vendor_id as assigned_blogger_id,
                v.name as blogger_name,
                nopd.reject_reason as rejection_reason
            FROM new_orders o
            LEFT JOIN users m ON o.manager_id = m.id
            LEFT JOIN users t ON o.team_id = t.id
            LEFT JOIN LATERAL (
                SELECT status, writer_id, id 
                FROM new_order_processes 
                WHERE new_order_id = o.id 
                ORDER BY id DESC LIMIT 1
            ) nop ON true
            LEFT JOIN users w ON nop.writer_id = w.id
            LEFT JOIN LATERAL (
                SELECT vendor_id, reject_reason
                FROM new_order_process_details 
                WHERE new_order_process_id = nop.id 
                ORDER BY id DESC LIMIT 1
            ) nopd ON true
            LEFT JOIN users v ON nopd.vendor_id = v.id
            WHERE 1=1
        `;

        const params = [];
        let paramIndex = 1;

        if (filters.manager_id) {
            sql += ` AND o.manager_id = $${paramIndex}`;
            params.push(filters.manager_id);
            paramIndex++;
        }

        if (filters.assigned_team_id) {
            sql += ` AND o.team_id = $${paramIndex}`;
            params.push(filters.assigned_team_id);
            paramIndex++;
        }

        if (filters.current_status) {
            const dbStatus = STATUS_MAP[filters.current_status] || 1;
            // CRITICAL FIX: Also check process status to exclude completed orders
            // This prevents orders with new_order_status=4 but process_status=5 from appearing
            sql += ` AND o.new_order_status = $${paramIndex} AND nop.status = $${paramIndex}`;
            params.push(dbStatus);
            paramIndex++;
        }

        if (filters.assigned_writer_id) {
            sql += ` AND EXISTS (SELECT 1 FROM new_order_processes nop WHERE nop.new_order_id = o.id AND nop.writer_id = $${paramIndex})`;
            params.push(filters.assigned_writer_id);
            paramIndex++;
        }

        if (filters.assigned_blogger_id) {
            sql += ` AND EXISTS (
                SELECT 1 FROM new_order_process_details nopd 
                JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id 
                WHERE nop.new_order_id = o.id AND nopd.vendor_id = $${paramIndex}
            )`;
            params.push(filters.assigned_blogger_id);
            paramIndex++;
        }

        sql += ' ORDER BY COALESCE(o.updated_at, o.created_at) DESC NULLS LAST';

        const result = await query(sql, params);

        return result.rows.map(row => ({
            id: row.id,
            manual_order_id: row.manual_order_id,
            client_name: row.client_name,
            client_website: row.client_website,
            no_of_links: row.no_of_links,
            order_type: row.order_type,
            order_package: row.order_package,
            notes: row.notes,
            category: row.category,
            fc: row.fc,
            manager_id: row.manager_id,
            assigned_team_id: row.assigned_team_id,
            assigned_writer_id: row.assigned_writer_id,
            assigned_blogger_id: row.assigned_blogger_id,
            manager_name: row.manager_name,
            team_name: row.team_name,
            writer_name: row.writer_name,
            blogger_name: row.blogger_name,
            rejection_reason: row.rejection_reason,
            current_status: this.mapStatus(row.process_status || row.new_order_status, row.assigned_writer_id, row.assigned_blogger_id),
            created_at: row.created_at,
            updated_at: row.updated_at
        }));
    }

    /**
     * Find task by ID
     */
    static async findById(id) {
        const result = await query(
            `SELECT 
                o.*,
                m.name as manager_name,
                t.name as team_name
            FROM new_orders o
            LEFT JOIN users m ON o.manager_id = m.id
            LEFT JOIN users t ON o.team_id = t.id
            WHERE o.id = $1`,
            [id]
        );

        if (!result.rows[0]) return null;

        const order = result.rows[0];

        // Get latest process info
        const processResult = await query(
            `SELECT nop.*, 
                    w.name as writer_name,
                    w.id as writer_id
             FROM new_order_processes nop
             LEFT JOIN users w ON nop.writer_id = w.id
             WHERE nop.new_order_id = $1
             ORDER BY nop.id DESC
             LIMIT 1`,
            [id]
        );

        const process = processResult.rows[0] || {};

        // Get process details (sites/vendors)
        const detailsResult = await query(
            `SELECT nopd.*, 
                    ns.root_domain as website_domain,
                    ns.da as website_da,
                    ns.dr as website_dr,
                    ns.traffic_source as website_traffic,
                    ns.gp_price as website_gp_price,
                    ns.niche_edit_price as website_niche_price,
                    v.name as blogger_name,
                    v.id as vendor_id
             FROM new_order_process_details nopd
             LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
             LEFT JOIN users v ON nopd.vendor_id = v.id
             WHERE nopd.new_order_process_id = $1`,
            [process.id || 0]
        );

        const detail = detailsResult.rows[0] || {};

        // Map all details to selected_websites array
        const selected_websites = detailsResult.rows.map(row => ({
            id: row.id,
            website_id: row.new_site_id,
            domain_url: row.website_domain,
            dr: row.website_dr,
            da: row.website_da,
            traffic: row.website_traffic,
            gp_price: row.website_gp_price,
            niche_price: row.website_niche_price,
            notes: row.note,
            copy_url: row.doc_urls || row.url,  // Copy URLs from team
            post_url: row.doc_urls,             // Post URL for Niche Edit
            doc_urls: row.doc_urls,             // Doc URLs for GP
            content_link: row.doc_urls,         // Alias for doc URLs  
            content_file: row.upload_doc_file,   // External doc file
            target_url: row.url,
            anchor_text: row.anchor,
            article_title: row.title,
            upfront_payment: row.upfront_payment || false,
            paypal_id: row.paypal_email,
            // Niche Edit writer submission fields
            insert_after: row.insert_after,
            statement: row.statement,
            writer_note: row.note,
            option_type: row.type || 'insert', // Map DB 'type' to 'option_type'
            replace_with: row.insert_after,    // Reuse column for replace_with
            replace_statement: row.statement,   // Reuse column for replace_statement
            is_rejected: Number(row.status) === 11 // Pass the rejected status natively, type-safe
        }));

        return {
            id: order.id,
            manual_order_id: order.order_id,
            client_name: order.client_name,
            client_website: order.client_website,
            no_of_links: order.no_of_links,
            order_type: order.order_type,
            order_package: order.order_package,
            notes: order.message,
            category: order.category,
            fc: order.fc,
            manager_id: order.manager_id,
            manager_name: order.manager_name,
            assigned_team_id: order.team_id,
            team_name: order.team_name,
            assigned_writer_id: process.writer_id,
            writer_name: process.writer_name,
            assigned_blogger_id: detail.vendor_id,
            blogger_name: detail.blogger_name,
            website_id: detail.new_site_id,
            website_domain: detail.website_domain,
            website_da: detail.website_da,
            website_dr: detail.website_dr,
            website_traffic: detail.website_traffic,
            website_gp_price: detail.website_gp_price,
            website_niche_price: detail.website_niche_price,
            content_body: process.doc_urls || process.note,
            content_instructions: process.statement,
            live_published_url: detail.submit_url,
            rejection_reason: detail.reject_reason,
            current_status: this.mapStatus(process.status || order.new_order_status, process.writer_id, detail.vendor_id, detail.submit_url),
            created_at: order.created_at,
            updated_at: order.updated_at,
            // Include raw process data for compatibility
            process_id: process.id,
            process_detail_id: detail.id,
            // Selected websites array for pending teams flow
            selected_websites
        };
    }

    /**
     * Create new task (Manager creates and pushes to Team)
     */
    static async create(taskData) {
        const {
            manager_id, assigned_team_id, client_name, client_website,
            no_of_links, order_type, order_package, notes, category,
            manual_order_id, fc, created_by
        } = taskData;

        // Generate order ID if not provided
        const orderId = manual_order_id || `ORD-${Date.now()}`;

        // Check if order_id already exists (uniqueness validation)
        const existingOrder = await query(
            'SELECT id FROM new_orders WHERE order_id = $1',
            [orderId]
        );
        if (existingOrder.rows.length > 0) {
            const error = new Error(`Order ID "${orderId}" already exists. Please use a unique ID.`);
            error.statusCode = 400;
            throw error;
        }

        const result = await query(
            `INSERT INTO new_orders (
                manager_id, team_id, order_id, client_name, client_website,
                no_of_links, order_type, order_package, message, category,
                new_order_status, fc, type, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) 
            RETURNING *`,
            [
                manager_id || created_by,
                assigned_team_id || 0,
                orderId,
                client_name || '',
                client_website || '',
                no_of_links || '1',
                order_type || 'Guest Post',
                order_package || 'Standard',
                notes || '',
                category || '',
                2, // Status: Pending Manager Approval
                fc ? 1 : 0,
                order_type || 'Guest Post'
            ]
        );

        const order = result.rows[0];

        // Create initial process record
        await query(
            `INSERT INTO new_order_processes (
                new_order_id, team_id, manager_id, status, note, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [order.id, assigned_team_id || 0, manager_id || created_by, 1, notes || '']
        );

        return {
            ...order,
            current_status: 'PENDING_MANAGER_APPROVAL_1',
            notes: order.message
        };
    }

    /**
     * Update task status
     */
    static async updateStatus(id, newStatus, additionalData = {}) {
        const dbStatus = STATUS_MAP[newStatus] || 1;

        // Update order status
        await query(
            `UPDATE new_orders SET new_order_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [dbStatus, id]
        );

        // Update or create process record
        const processResult = await query(
            `SELECT id FROM new_order_processes WHERE new_order_id = $1 ORDER BY id DESC LIMIT 1`,
            [id]
        );

        if (processResult.rows[0]) {
            const updateFields = ['status = $1'];
            const updateParams = [dbStatus];
            let paramIndex = 2;

            if (additionalData.assigned_writer_id) {
                updateFields.push(`writer_id = $${paramIndex}`);
                updateParams.push(additionalData.assigned_writer_id);
                paramIndex++;
            }
            if (additionalData.content_body) {
                updateFields.push(`doc_urls = $${paramIndex}`);
                updateParams.push(additionalData.content_body);
                paramIndex++;
            }
            if (additionalData.content_instructions) {
                updateFields.push(`statement = $${paramIndex}`);
                updateParams.push(additionalData.content_instructions);
                paramIndex++;
            }
            if (additionalData.notes) {
                updateFields.push(`note = $${paramIndex}`);
                updateParams.push(additionalData.notes);
                paramIndex++;
            }

            updateParams.push(processResult.rows[0].id);

            await query(
                `UPDATE new_order_processes SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $${paramIndex}`,
                updateParams
            );

            // Update process details if blogger/vendor related
            if (additionalData.assigned_blogger_id || additionalData.live_published_url) {
                const detailResult = await query(
                    `SELECT id FROM new_order_process_details WHERE new_order_process_id = $1 ORDER BY id DESC LIMIT 1`,
                    [processResult.rows[0].id]
                );

                if (detailResult.rows[0]) {
                    const detailUpdates = [];
                    const detailParams = [];
                    let pIdx = 1;

                    if (additionalData.assigned_blogger_id) {
                        detailUpdates.push(`vendor_id = $${pIdx}`);
                        detailParams.push(additionalData.assigned_blogger_id);
                        pIdx++;
                    }
                    if (additionalData.live_published_url) {
                        detailUpdates.push(`submit_url = $${pIdx}`);
                        detailParams.push(additionalData.live_published_url);
                        pIdx++;
                    }
                    if (additionalData.rejection_reason) {
                        detailUpdates.push(`reject_reason = $${pIdx}`);
                        detailParams.push(additionalData.rejection_reason);
                        pIdx++;
                    }

                    detailParams.push(detailResult.rows[0].id);

                    await query(
                        `UPDATE new_order_process_details SET ${detailUpdates.join(', ')}, updated_at = CURRENT_TIMESTAMP 
                         WHERE id = $${pIdx}`,
                        detailParams
                    );
                }
            }
        }

        return await this.findById(id);
    }

    /**
     * WORKFLOW STEP 1: Manager assigns task to Team
     */
    static async assignToTeam(id, teamId, taskDetails = {}) {
        await query(
            `UPDATE new_orders SET team_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [teamId, id]
        );
        return await this.updateStatus(id, 'PENDING_MANAGER_APPROVAL_1', taskDetails);
    }

    /**
     * WORKFLOW STEP 2: Team selects website and submits back to Manager
     */
    static async teamSubmitWebsite(id, websiteId, notes) {
        // Get process ID
        const processResult = await query(
            `SELECT id FROM new_order_processes WHERE new_order_id = $1 ORDER BY id DESC LIMIT 1`,
            [id]
        );

        if (processResult.rows[0]) {
            // Create or update process detail with site
            await query(
                `INSERT INTO new_order_process_details (new_order_process_id, new_site_id, price, note)
                 VALUES ($1, $2, 0, $3)
                 ON CONFLICT DO NOTHING`,
                [processResult.rows[0].id, websiteId, notes || '']
            );
        }

        return await this.updateStatus(id, 'PENDING_MANAGER_APPROVAL_1', { notes });
    }

    /**
     * WORKFLOW STEP 3: Manager approves website & assigns to Writer
     */
    static async assignToWriter(id, writerId, instructions) {
        return await this.updateStatus(id, 'ASSIGNED_TO_WRITER', {
            assigned_writer_id: writerId,
            content_instructions: instructions
        });
    }

    /**
     * Writer marks task as in progress
     */
    static async markWritingInProgress(id) {
        return await this.updateStatus(id, 'WRITING_IN_PROGRESS', {});
    }

    /**
     * WORKFLOW STEP 4: Writer completes content and submits to Manager
     */
    static async submitContent(id, contentBody) {
        return await this.updateStatus(id, 'PENDING_MANAGER_APPROVAL_2', {
            content_body: contentBody
        });
    }

    /**
     * Manager returns task to Writer for revision
     */
    static async returnToWriter(id, reason) {
        return await this.updateStatus(id, 'ASSIGNED_TO_WRITER', {
            rejection_reason: reason
        });
    }

    /**
     * WORKFLOW STEP 5: Manager approves content and assigns to Blogger (vendor)
     */
    static async assignToBlogger(id, bloggerId) {
        return await this.updateStatus(id, 'ASSIGNED_TO_BLOGGER', {
            assigned_blogger_id: bloggerId
        });
    }

    /**
     * WORKFLOW STEP 6: Blogger publishes and submits URL
     */
    static async submitLiveLink(id, liveUrl) {
        return await this.updateStatus(id, 'PENDING_FINAL_CHECK', {
            live_published_url: liveUrl
        });
    }

    /**
     * WORKFLOW STEP 7: Manager verifies and credits Blogger
     */
    static async markAsCompleted(id, paymentAmount) {
        return await this.updateStatus(id, 'CREDITED', {
            payment_amount: paymentAmount
        });
    }

    /**
     * Reject task at any stage
     */
    static async reject(id, rejectionReason) {
        return await this.updateStatus(id, 'REJECTED', {
            rejection_reason: rejectionReason
        });
    }

    /**
     * Get task statistics
     */
    static async getStatistics() {
        const result = await query(`
            SELECT 
                new_order_status,
                COUNT(*) as count
            FROM new_orders
            GROUP BY new_order_status
        `);

        const stats = {};
        result.rows.forEach(row => {
            const appStatus = STATUS_MAP_REVERSE[row.new_order_status] || 'UNKNOWN';
            stats[appStatus] = parseInt(row.count);
        });

        return stats;
    }

    /**
     * Get tasks for specific workflow stage
     */
    static async getByWorkflowStage(stage) {
        const stageMapping = {
            'pending_team': [1, 2],
            'pending_writer_assignment': [2],
            'with_writer': [3],
            'pending_content_approval': [4],
            'with_blogger': [5],
            'pending_verification': [5],
            'completed': [5],
            'rejected': [11]
        };

        const statuses = stageMapping[stage] || [];
        if (statuses.length === 0) return [];

        const placeholders = statuses.map((_, i) => `$${i + 1}`).join(', ');
        const result = await query(
            `SELECT o.*, 
                m.name as manager_name,
                t.name as team_name
            FROM new_orders o
            LEFT JOIN users m ON o.manager_id = m.id
            LEFT JOIN users t ON o.team_id = t.id
            WHERE o.new_order_status IN (${placeholders})
            ORDER BY o.created_at DESC`,
            statuses
        );

        return result.rows.map(row => ({
            ...row,
            current_status: this.mapStatus(row.new_order_status),
            notes: row.message
        }));
    }
}

module.exports = Task;
