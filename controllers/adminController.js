const User = require('../models/User');
const Website = require('../models/Website');
const Task = require('../models/Task');
const PriceChart = require('../models/PriceChart');
const Transaction = require('../models/Transaction');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const PDFDocument = require('pdfkit');
const jwt = require('jsonwebtoken');

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

/**
 * Admin Controller
 * Handles admin-specific operations
 */

// ==================== USER MANAGEMENT ====================

/**
 * @route   GET /api/admin/users
 * @desc    Get all users
 * @access  Admin only
 */
const getAllUsers = async (req, res, next) => {
    try {
        const { role, is_active } = req.query;

        const filters = {};
        if (role) filters.role = role;
        if (is_active !== undefined) filters.is_active = is_active === 'true';

        const users = await User.findAll(filters);

        res.json({
            count: users.length,
            users
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/admin/users
 * @desc    Create new user
 * @access  Admin only
 */
const createUser = async (req, res, next) => {
    try {
        const { username, email, password, role } = req.body;

        // Validation
        if (!username || !email || !password || !role) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Username, email, password, and role are required'
            });
        }

        // Validate role
        const validRoles = ['Admin', 'Manager', 'Team', 'Writer', 'Blogger'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({
                error: 'Validation Error',
                message: `Invalid role. Must be one of: ${validRoles.join(', ')}`
            });
        }

        const user = await User.create({ username, email, password, role });

        res.status(201).json({
            message: 'User created successfully',
            user
        });
    } catch (error) {
        if (error.code === '23505') { // Unique violation
            return res.status(409).json({
                error: 'Conflict',
                message: 'User with this email or username already exists'
            });
        }
        next(error);
    }
};

/**
 * @route   PUT /api/admin/users/:id
 * @desc    Update user
 * @access  Admin only
 */
const updateUser = async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const user = await User.update(id, updates);

        if (!user) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'User not found'
            });
        }

        res.json({
            message: 'User updated successfully',
            user
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   DELETE /api/admin/users/:id
 * @desc    Delete user
 * @access  Admin only
 */
const deleteUser = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Prevent admin from deleting themselves
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Cannot delete your own account'
            });
        }

        const user = await User.delete(id);

        if (!user) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'User not found'
            });
        }

        res.json({
            message: 'User deleted successfully'
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/admin/users/:id/impersonate
 * @desc    Generate an impersonation token for a target user
 * @access  Admin only
 */
const impersonateUser = async (req, res, next) => {
    try {
        const targetUserId = req.params.id;

        // Fetch user from DB
        const user = await User.findById(targetUserId);

        if (!user) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Target user not found'
            });
        }
        
        // Prevent impersonating another Admin (security measure)
        if (user.role === 'Admin') {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'Cannot impersonate another Admin'
            });
        }

        // Generate JWT token for target user
        const token = jwt.sign(
            {
                id: user.id,
                email: user.email,
                role: user.role
            },
            process.env.JWT_SECRET,
            {
                expiresIn: process.env.JWT_EXPIRES_IN || '24h'
            }
        );

        logger.info('Auth', `Admin ${req.user.id} initiated impersonation for user ${user.id} (${user.email})`);

        // Return user data and token 
        res.json({
            message: 'Impersonation successful',
            token,
            user: {
                id: user.id,
                username: user.username,
                name: user.name,
                email: user.email,
                role: user.role,
                wallet_balance: user.wallet_balance,
                profile_image: user.profile_image
            }
        });
    } catch (error) {
        logger.error('Admin:Impersonate', error, { targetId: req.params.id });
        next(error);
    }
};

// ==================== WEBSITE MANAGEMENT ====================

/**
 * @route   GET /api/admin/websites
 * @desc    Get all websites
 * @access  Admin only
 */
const getAllWebsites = async (req, res, next) => {
    try {
        const { status, category } = req.query;

        const filters = {};
        if (status) filters.status = status;
        if (category) filters.category = category;

        const websites = await Website.findAll(filters);

        res.json({
            count: websites.length,
            websites
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/admin/websites
 * @desc    Create new website
 * @access  Admin only
 */
const createWebsite = async (req, res, next) => {
    try {
        const { domain_url, category, da_pa_score, status } = req.body;

        if (!domain_url) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Domain URL is required'
            });
        }

        const website = await Website.create({
            domain_url,
            category,
            da_pa_score,
            status,
            added_by: req.user.id
        });

        res.status(201).json({
            message: 'Website created successfully',
            website
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/admin/websites/upload
 * @desc    Bulk upload websites from CSV
 * @access  Admin only
 */
const uploadWebsitesCSV = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'CSV file is required'
            });
        }

        const websites = [];
        const errors = [];

        // Parse CSV
        await new Promise((resolve, reject) => {
            fs.createReadStream(req.file.path)
                .pipe(csv())
                .on('data', (row) => {
                    // Expected columns: domain_url, category, da_pa_score
                    if (row.domain_url) {
                        websites.push({
                            domain_url: row.domain_url,
                            category: row.category || null,
                            da_pa_score: row.da_pa_score ? parseInt(row.da_pa_score) : null
                        });
                    } else {
                        errors.push(`Invalid row: ${JSON.stringify(row)}`);
                    }
                })
                .on('end', resolve)
                .on('error', reject);
        });

        // Bulk insert
        const created = await Website.bulkCreate(websites, req.user.id);

        // Clean up uploaded file
        fs.unlinkSync(req.file.path);

        res.json({
            message: 'Websites uploaded successfully',
            total_uploaded: created.length,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        // Clean up file on error
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        next(error);
    }
};

/**
 * @route   GET /api/admin/websites/:id
 * @desc    Get website by ID for editing
 * @access  Admin only
 */
const getWebsiteById = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Return raw new_sites columns so EditSite.jsx field mapping works directly
        const result = await query(
            `SELECT 
                ns.id,
                ns.root_domain,
                ns.niche,
                ns.website_niche,
                ns.country_source,
                ns.spam_score,
                ns.sample_url,
                ns.website_status,
                ns.href_url,
                ns.marked_sponsor,
                ns.grey_niche_types,
                ns.da,
                ns.dr,
                ns.traffic,
                ns.gp_price,
                ns.rd,
                ns.niche_edit_price,
                ns.deal_cbd_casino,
                ns.fc_gp,
                ns.fc_ne,
                ns.paypal_id,
                ns.whatsapp,
                ns.skype,
                ns.site_status,
                ns.uploaded_user_id as blogger_id,
                ns.created_at,
                ns.updated_at,
                u.name as blogger_name
             FROM new_sites ns
             LEFT JOIN users u ON ns.uploaded_user_id = u.id
             WHERE ns.id = $1`,
            [id]
        );

        if (!result.rows[0]) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Website not found'
            });
        }

        res.json(result.rows[0]);
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/websites/:id
 * @desc    Update website
 * @access  Admin only
 */
const updateWebsite = async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const website = await Website.update(id, updates);

        if (!website) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Website not found'
            });
        }

        res.json({
            message: 'Website updated successfully',
            website
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   DELETE /api/admin/websites/:id
 * @desc    Delete website
 * @access  Admin only
 */
// Original deleteWebsite removed as it was redeclared below to use soft-deletes via database queries instead of the undefined Website model.


// ==================== DASHBOARD STATISTICS ====================

/**
 * @route   GET /api/admin/stats
 * @desc    Get admin dashboard statistics
 * @access  Admin only
 */
const getStatistics = async (req, res, next) => {
    try {
        const [
            totalUsers,
            totalWebsites,
            activeWebsites,
            taskStats
        ] = await Promise.all([
            User.findAll(),
            Website.findAll(),
            Website.findAll({ status: 'Active' }),
            Task.getStatistics()
        ]);

        const stats = {
            users: {
                total: totalUsers.length,
                by_role: {}
            },
            websites: {
                total: totalWebsites.length,
                active: activeWebsites.length
            },
            tasks: taskStats
        };

        // Count users by role
        totalUsers.forEach(user => {
            stats.users.by_role[user.role] = (stats.users.by_role[user.role] || 0) + 1;
        });

        // Frontend expects { statistics: { bloggers_count, managers_count, ... } }
        const statistics = {
            bloggers_count: stats.users.by_role['Blogger'] || 0,
            managers_count: stats.users.by_role['Manager'] || 0,
            team_count: stats.users.by_role['Team'] || 0,
            writers_count: stats.users.by_role['Writer'] || 0,
            total_users: stats.users.total,
            total_websites: stats.websites.total,
            active_websites: stats.websites.active,
            tasks: stats.tasks
        };

        res.json({ statistics, ...stats });
    } catch (error) {
        next(error);
    }
};

// ==================== PRICE CHARTS MANAGEMENT ====================

/**
 * @route   GET /api/admin/price-charts
 * @desc    Get all price chart entries
 * @access  Admin only
 */
const getAllPriceCharts = async (req, res, next) => {
    try {
        const { is_active } = req.query;

        const filters = {};
        if (is_active !== undefined) filters.is_active = is_active === 'true';

        const priceCharts = await PriceChart.findAll(filters);

        res.json({
            count: priceCharts.length,
            price_charts: priceCharts
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/admin/price-charts
 * @desc    Create new price chart entry
 * @access  Admin only
 */
const createPriceChart = async (req, res, next) => {
    try {
        const {
            rd_min, rd_max, traffic_min, traffic_max,
            dr_min, dr_max, da_min, da_max,
            niche_price_min, niche_price_max,
            gp_price_min, gp_price_max
        } = req.body;

        // Validation
        if (rd_min === undefined || traffic_min === undefined) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'RD and Traffic ranges are required'
            });
        }

        const priceChart = await PriceChart.create({
            rd_min: parseInt(rd_min) || 0,
            rd_max: parseInt(rd_max) || 0,
            traffic_min: parseInt(traffic_min) || 0,
            traffic_max: parseInt(traffic_max) || 0,
            dr_min: parseInt(dr_min) || 0,
            dr_max: parseInt(dr_max) || 0,
            da_min: parseInt(da_min) || 0,
            da_max: parseInt(da_max) || 0,
            niche_price_min: parseFloat(niche_price_min) || 0,
            niche_price_max: parseFloat(niche_price_max) || 0,
            gp_price_min: parseFloat(gp_price_min) || 0,
            gp_price_max: parseFloat(gp_price_max) || 0
        });

        res.status(201).json({
            message: 'Price chart entry created successfully',
            price_chart: priceChart
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/price-charts/:id
 * @desc    Update price chart entry
 * @access  Admin only
 */
const updatePriceChart = async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const priceChart = await PriceChart.update(id, updates);

        if (!priceChart) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Price chart entry not found'
            });
        }

        res.json({
            message: 'Price chart entry updated successfully',
            price_chart: priceChart
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   DELETE /api/admin/price-charts/:id
 * @desc    Delete price chart entry
 * @access  Admin only
 */
const deletePriceChart = async (req, res, next) => {
    try {
        const { id } = req.params;

        const priceChart = await PriceChart.delete(id);

        if (!priceChart) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Price chart entry not found'
            });
        }

        res.json({
            message: 'Price chart entry deleted successfully'
        });
    } catch (error) {
        next(error);
    }
};

// ==================== TASKS (Admin Overview) ====================

/**
 * @route   GET /api/admin/tasks
 * @desc    Get all tasks for admin overview
 * @access  Admin only
 */
const getAllTasks = async (req, res, next) => {
    try {
        const result = await Task.findAll();
        res.json({
            count: result.length,
            tasks: result
        });
    } catch (error) {
        next(error);
    }
};

// ==================== WITHDRAWALS (Admin Overview) ====================

/**
 * @route   GET /api/admin/withdrawals
 * @desc    Get all withdrawal requests for admin overview
 * @access  Admin only
 */
const getAllWithdrawals = async (req, res, next) => {
    try {
        const withdrawals = await Transaction.findAll();
        res.json({
            count: withdrawals.length,
            withdrawals: withdrawals.map(w => ({
                ...w,
                username: w.user_name,
                email: w.user_email
            }))
        });
    } catch (error) {
        next(error);
    }
};

// ==================== WALLET MANAGEMENT ====================

const { query } = require('../config/database');
/**
 * @route   GET /api/admin/wallet/bloggers
 * @desc    Get all bloggers with their wallet balances with pagination
 * @access  Admin only
 */
const getBloggersWallets = async (req, res, next) => {
    try {
        const {
            search,
            sort_by = 'wallet_balance',
            sort_order = 'desc',
            page = 1,
            limit = 50
        } = req.query;

        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 50;
        const offset = (pageNum - 1) * limitNum;

        // Base query to get all bloggers with their wallet balance (unapproved credits)
        let countSql = `
            SELECT COUNT(*) as total
            FROM users u
            WHERE u.role = 'Blogger' OR EXISTS (
                SELECT 1 FROM wallets w WHERE w.user_id = u.id
            )
        `;

        let sql = `
            SELECT 
                u.id,
                u.name,
                u.email,
                COALESCE(
                    (SELECT SUM(
                        COALESCE(
                            NULLIF(nopd.price, 0), 
                            CASE WHEN ns.niche_edit_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.niche_edit_price::DOUBLE PRECISION ELSE NULL END,
                            CASE WHEN ns.gp_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.gp_price::DOUBLE PRECISION ELSE NULL END,
                            0
                        )
                    )
                     FROM new_order_process_details nopd
                     JOIN new_sites ns ON nopd.new_site_id = ns.id
                     WHERE nopd.vendor_id = u.id 
                       AND nopd.status = 8
                       AND nopd.id NOT IN (
                           SELECT wh.order_detail_id 
                           FROM wallet_histories wh
                           JOIN withdraw_requests wr ON wh.withdraw_request_id = wr.id
                           WHERE wr.status = 1
                             AND wh.order_detail_id IS NOT NULL
                       )
                       AND nopd.id NOT IN (
                           SELECT wh2.order_detail_id
                           FROM wallet_histories wh2
                           WHERE wh2.approved_date IS NOT NULL
                             AND wh2.order_detail_id IS NOT NULL
                       )), 
                    0
                ) as wallet_balance
            FROM users u
            WHERE u.role = 'Blogger' OR EXISTS (
                SELECT 1 FROM wallets w WHERE w.user_id = u.id
            )
        `;

        const params = [];
        const countParams = [];
        let paramIndex = 1;
        let countParamIndex = 1;

        if (search) {
            const searchCondition = ` AND (u.name ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex})`;
            sql += searchCondition;
            countSql += ` AND (u.name ILIKE $${countParamIndex} OR u.email ILIKE $${countParamIndex})`;
            params.push(`%${search}%`);
            countParams.push(`%${search}%`);
            paramIndex++;
            countParamIndex++;
        }

        // Get total count
        const countResult = await query(countSql, countParams);
        const total = parseInt(countResult.rows[0]?.total || 0);

        // Sorting
        const validSortColumns = ['name', 'email', 'wallet_balance'];
        const sortColumn = validSortColumns.includes(sort_by) ? sort_by : 'wallet_balance';
        const sortDirection = sort_order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        sql += ` ORDER BY ${sortColumn} ${sortDirection}`;

        // Pagination
        sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limitNum, offset);

        const result = await query(sql, params);

        res.json({
            count: result.rows.length,
            total,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(total / limitNum),
            bloggers: result.rows
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/admin/wallet/payment-history
 * @desc    Get payment history (withdrawal requests) with full details
 * @access  Admin only
 */
const getPaymentHistory = async (req, res, next) => {
    try {
        const {
            search,
            filter_name,
            filter_email,
            filter_payment_method,
            filter_status,
            filter_clearance_date,
            sort_by = 'created_at',
            sort_order = 'desc',
            page = 1,
            limit = 50
        } = req.query;

        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 50;
        const offset = (pageNum - 1) * limitNum;

        // Base Table: withdraw_requests
        // Join users for payment details (Bank, UPI, QR, etc.)
        // Join wallet_histories for Amount and Remarks

        let sql = `
            SELECT 
                wr.id,
                wr.user_id,
                wr.status,
                wr.created_at as request_date,
                u.name as user_name,
                u.email as user_email,
                
                -- Aggregated Amount using site prices as fallback
                COALESCE(SUM(
                    CASE 
                        WHEN wh.price > 0 THEN wh.price
                        WHEN ns.niche_edit_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.niche_edit_price::DOUBLE PRECISION
                        WHEN ns.gp_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.gp_price::DOUBLE PRECISION
                        ELSE 0
                    END
                ), 0) as amount,
                
                -- Clearance date from wallet_histories (approved_date)
                MAX(wh.approved_date) as clearance_date,
                
                -- Remarks from wallet_histories
                STRING_AGG(DISTINCT wh.remarks, '; ' ORDER BY wh.remarks) FILTER (WHERE wh.remarks IS NOT NULL AND wh.remarks != '') as remarks,
                
                -- Payment Details from Wallet Histories (snapshot at time of transaction)
                MAX(wh.payment_method) as payment_method,
                MAX(wh.paypal_email) as paypal_email,
                MAX(wh.upi_id) as upi_id,
                MAX(wh.qr_code_image) as qr_code_image,
                MAX(wh.beneficiary_name) as beneficiary_name,
                MAX(wh.beneficiary_account_number) as beneficiary_account_number,
                MAX(wh.bank_name) as bank_name,
                MAX(wh.ifsc_code) as ifsc_code,
                MAX(wh.swift_code) as swift_code,
                MAX(wh.bank_address) as bank_address,
                MAX(wh.bene_bank_name) as bene_bank_name,
                MAX(wh.bene_bank_branch_name) as bene_bank_branch_name,
                MAX(wh.ac_holder_name) as ac_holder_name,
                MAX(wh.account_number) as account_number,
                MAX(wh.bank_type) as bank_type

            FROM withdraw_requests wr
            JOIN users u ON wr.user_id = u.id
            LEFT JOIN wallet_histories wh ON wh.withdraw_request_id = wr.id
            LEFT JOIN new_order_process_details nopd ON wh.order_detail_id = nopd.id
            LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
            WHERE wr.status = 1
        `;

        const params = [];
        let paramIndex = 1;

        // --- PRE-GROUP-BY WHERE filters ---
        if (search) {
            sql += ` AND (u.name ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (filter_name) {
            sql += ` AND u.name ILIKE $${paramIndex}`;
            params.push(`%${filter_name}%`);
            paramIndex++;
        }

        if (filter_email) {
            sql += ` AND u.email ILIKE $${paramIndex}`;
            params.push(`%${filter_email}%`);
            paramIndex++;
        }

        // Status is always 1 (Paid)

        // Group by for aggregation
        sql += ` GROUP BY wr.id, u.id `;

        // --- POST-GROUP-BY HAVING filters (for aggregated columns) ---
        const havingClauses = [];

        if (filter_payment_method) {
            havingClauses.push(`MAX(wh.payment_method) ILIKE $${paramIndex}`);
            params.push(`%${filter_payment_method}%`);
            paramIndex++;
        }

        if (filter_clearance_date) {
            havingClauses.push(`DATE(MAX(wh.approved_date)) = $${paramIndex}::date`);
            params.push(filter_clearance_date);
            paramIndex++;
        }

        if (havingClauses.length > 0) {
            sql += ` HAVING ${havingClauses.join(' AND ')} `;
        }

        // --- Get total count using the same filters (wrap in subquery) ---
        const countSql = `SELECT COUNT(*) as total FROM (${sql}) as filtered`;
        const countResult = await query(countSql, params.slice()); // use same params without LIMIT/OFFSET
        const total = parseInt(countResult.rows[0]?.total || 0);

        // Sorting
        const validSortColumns = ['user_name', 'amount', 'created_at', 'updated_at'];
        const sortColumn = validSortColumns.includes(sort_by) ? sort_by : 'created_at';
        const sortDirection = sort_order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

        // Handle sort column mapping
        let orderByClause = '';
        if (sortColumn === 'user_name') orderByClause = `u.name ${sortDirection}`;
        else if (sortColumn === 'amount') orderByClause = `amount ${sortDirection}`;
        else if (sortColumn === 'created_at') orderByClause = `wr.created_at ${sortDirection}`;
        else if (sortColumn === 'updated_at') orderByClause = `wr.updated_at ${sortDirection}`;

        sql += ` ORDER BY ${orderByClause} NULLS LAST`;

        // Pagination
        sql += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limitNum, offset);

        const result = await query(sql, params);

        res.json({
            count: result.rows.length,
            total,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(total / limitNum),
            payments: result.rows
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/admin/wallet/withdrawal-requests
 * @desc    Get all withdrawal requests with payment method details
 * @access  Admin only
 */
const getWithdrawalRequests = async (req, res, next) => {
    try {
        const { search, status, sort_by = 'created_at', sort_order = 'desc', limit = 100 } = req.query;

        let sql = `
            SELECT 
                wr.id,
                wr.invoice_number,
                wr.invoice_pre,
                wr.status,
                wr.created_at as datetime,
                u.id as user_id,
                u.name as user_name,
                u.email as user_email,
                
                -- Aggregated amount using site prices as fallback
                COALESCE(SUM(
                    CASE 
                        WHEN wh.price > 0 THEN wh.price
                        WHEN ns.niche_edit_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.niche_edit_price::DOUBLE PRECISION
                        WHEN ns.gp_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.gp_price::DOUBLE PRECISION
                        ELSE 0
                    END
                ), 0) as amount,
                
                -- Payment details from wallet_histories (snapshot at withdrawal time)
                MAX(wh.payment_method) as payment_method,
                MAX(wh.paypal_email) as paypal_email,
                MAX(wh.upi_id) as upi_id,
                MAX(wh.qr_code_image) as qr_code_image,
                MAX(wh.bank_type) as bank_type,
                MAX(wh.beneficiary_name) as beneficiary_name,
                MAX(wh.beneficiary_account_number) as beneficiary_account_number,
                MAX(wh.customer_reference_number) as customer_reference_number,
                MAX(wh.ifsc_code) as ifsc_code,
                MAX(wh.bene_bank_name) as bene_bank_name,
                MAX(wh.bene_bank_branch_name) as bene_bank_branch_name,
                MAX(wh.beneficiary_email_id) as beneficiary_email_id,
                MAX(wh.ac_holder_name) as ac_holder_name,
                MAX(wh.bank_name) as bank_name,
                MAX(wh.account_number) as account_number,
                MAX(wh.swift_code) as swift_code,
                MAX(wh.bank_address) as bank_address
                
            FROM withdraw_requests wr
            JOIN users u ON wr.user_id = u.id
            LEFT JOIN wallet_histories wh ON wh.withdraw_request_id = wr.id
            LEFT JOIN new_order_process_details nopd ON wh.order_detail_id = nopd.id
            LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
            WHERE wr.status = 0
        `;

        const params = [];
        let paramIndex = 1;

        if (search) {
            sql += ` AND (u.name ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        // Allow overriding to show specific status (but default is pending only)
        if (status !== undefined && status !== null) {
            // Replace the default status filter
            sql = sql.replace('WHERE wr.status = 0', `WHERE wr.status = $${paramIndex}`);
            params.push(parseInt(status));
            paramIndex++;
        }

        // Group by for aggregation
        sql += ` GROUP BY wr.id, u.id`;

        // Sorting
        sql += ` ORDER BY wr.created_at ${sort_order.toLowerCase() === 'asc' ? 'ASC' : 'DESC'}`;
        sql += ` LIMIT $${paramIndex}`;
        params.push(parseInt(limit));

        const result = await query(sql, params);

        // Format invoice number
        const withdrawals = result.rows.map(row => ({
            ...row,
            invoice_number: row.invoice_pre ? `${row.invoice_pre}${row.invoice_number}` : (row.invoice_number || (100000 + parseInt(row.id))),
            status_text: row.status === 0 ? 'Pending' : row.status === 1 ? 'Approved' : 'Rejected'
        }));

        res.json({
            count: withdrawals.length,
            withdrawals
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/admin/wallet/withdrawal-requests/:id
 * @desc    Get details of a specific withdrawal request including all linked orders
 * @access  Admin only
 */
const getWithdrawalRequestDetail = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Get withdrawal request info
        const wrResult = await query(
            `SELECT 
                wr.id,
                wr.user_id,
                wr.status,
                wr.invoice_number,
                wr.invoice_pre,
                wr.created_at,
                u.name as user_name,
                u.email as user_email
             FROM withdraw_requests wr
             JOIN users u ON wr.user_id = u.id
             WHERE wr.id = $1`,
            [id]
        );

        console.log(`[DEBUG] wrResult count: ${wrResult.rows.length}`);

        if (wrResult.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Withdrawal request not found'
            });
        }

        const withdrawal = wrResult.rows[0];

        // Get all orders linked to this withdrawal request with site prices as fallback
        const ordersResult = await query(
            `SELECT 
                wh.id as wallet_history_id,
                wh.order_detail_id,
                CASE 
                    WHEN wh.price > 0 THEN wh.price
                    WHEN ns.niche_edit_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.niche_edit_price::DOUBLE PRECISION
                    WHEN ns.gp_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.gp_price::DOUBLE PRECISION
                    ELSE 0
                END as price,
                wh.created_at,
                wh.request_date,
                nopd.submit_url,
                ns.root_domain,
                ns.niche_edit_price,
                ns.gp_price,
                no.order_id,
                no.client_name
             FROM wallet_histories wh
             LEFT JOIN new_order_process_details nopd ON wh.order_detail_id = nopd.id
             LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
             LEFT JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             LEFT JOIN new_orders no ON nop.new_order_id = no.id
             WHERE wh.withdraw_request_id = $1
             ORDER BY wh.created_at DESC`,
            [id]
        );

        // Calculate total amount
        const totalAmount = ordersResult.rows.reduce((sum, row) => sum + parseFloat(row.price || 0), 0);

        res.json({
            withdrawal: {
                ...withdrawal,
                invoice_number: withdrawal.invoice_pre
                    ? `${withdrawal.invoice_pre}${withdrawal.invoice_number}`
                    : (withdrawal.invoice_number || (100000 + parseInt(withdrawal.id))),
                total_amount: totalAmount
            },
            orders: ordersResult.rows.map(o => ({
                id: o.wallet_history_id,
                order_detail_id: o.order_detail_id,
                order_id: o.order_id || `Order-${o.order_detail_id}`,
                submit_url: o.submit_url || '',
                root_domain: o.root_domain || '',
                price: parseFloat(o.price) || 0,
                created_at: o.created_at || o.request_date
            })),
            total_amount: totalAmount
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/wallet/withdrawal-requests/:id/approve
 * @desc    Approve a withdrawal request with mandatory remarks
 * @access  Admin only
 */
const approveWithdrawal = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { remarks } = req.body;

        // Remarks is mandatory
        if (!remarks || remarks.trim() === '') {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Remarks is required to approve a withdrawal request'
            });
        }

        // Get withdrawal request details and total amount (using site prices as fallback)
        const wrDetails = await query(
            `SELECT 
                wr.id, wr.user_id, wr.status,
                COALESCE(SUM(
                    CASE 
                        WHEN wh.price > 0 THEN wh.price
                        WHEN ns.niche_edit_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.niche_edit_price::DOUBLE PRECISION
                        WHEN ns.gp_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.gp_price::DOUBLE PRECISION
                        ELSE 0
                    END
                ), 0) as total_amount
             FROM withdraw_requests wr
             LEFT JOIN wallet_histories wh ON wh.withdraw_request_id = wr.id
             LEFT JOIN new_order_process_details nopd ON wh.order_detail_id = nopd.id
             LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
             WHERE wr.id = $1
             GROUP BY wr.id`,
            [id]
        );

        if (wrDetails.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Withdrawal request not found'
            });
        }

        const withdrawalRequest = wrDetails.rows[0];

        if (withdrawalRequest.status !== 0) {
            return res.status(400).json({
                error: 'Already Processed',
                message: 'This withdrawal request has already been processed'
            });
        }

        const userId = withdrawalRequest.user_id;
        const totalAmount = parseFloat(withdrawalRequest.total_amount) || 0;

        // Update withdraw_request status to approved (1)
        const wrUpdate = await query(
            `UPDATE withdraw_requests 
             SET status = 1, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $1 AND status = 0
             RETURNING *`,
            [id]
        );

        if (wrUpdate.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Withdrawal request not found or already processed'
            });
        }

        // Update all wallet_histories linked to this withdrawal request (debit entries)
        // Set approved_date and remarks
        await query(
            `UPDATE wallet_histories 
             SET status = 1, 
                 approved_date = CURRENT_TIMESTAMP, 
                 remarks = $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE withdraw_request_id = $2`,
            [remarks.trim(), id]
        );

        // CRITICAL FIX: Also update the original CREDIT entries' approved_date
        // The balance is calculated from credit entries where approved_date IS NULL.
        // When withdrawing, the blogger selects orders (order_detail_id), and debit entries are created
        // with those order_detail_ids. We need to mark the original credit entries for those
        // same order_detail_ids as approved, so they're excluded from the balance calculation.
        // 
        // Find order_detail_ids from the debit entries linked to this withdrawal,
        // then update matching credit entries for the same user.
        await query(
            `UPDATE wallet_histories 
             SET approved_date = CURRENT_TIMESTAMP, 
                 remarks = COALESCE(remarks, '') || ' [Withdrawn]',
                 updated_at = CURRENT_TIMESTAMP
             WHERE type = 'credit'
               AND approved_date IS NULL
               AND order_detail_id IN (
                   SELECT wh_debit.order_detail_id 
                   FROM wallet_histories wh_debit
                   WHERE wh_debit.withdraw_request_id = $1
                     AND wh_debit.order_detail_id IS NOT NULL
               )`,
            [id]
        );
        console.log(`✅ Updated original credit entries for withdrawal request ${id}`);

        // Deduct the withdrawal amount from blogger's wallet balance
        if (totalAmount > 0 && userId) {
            await query(
                `UPDATE wallets 
                 SET balance = balance - $1, 
                     updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = $2`,
                [totalAmount, userId]
            );
            console.log(`✅ Deducted ${totalAmount} from user ${userId} wallet for withdrawal request ${id}`);
        }

        res.json({
            message: 'Withdrawal request approved successfully',
            withdrawal: wrUpdate.rows[0],
            amount_deducted: totalAmount
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/wallet/withdrawal-requests/:id/reject
 * @desc    Reject a withdrawal request
 * @access  Admin only
 */
const rejectWithdrawal = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Rejection reason is required'
            });
        }

        const result = await Transaction.reject(id, req.user.id, reason);

        if (!result) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Withdrawal request not found'
            });
        }

        res.json({
            message: 'Withdrawal request rejected',
            withdrawal: result
        });
    } catch (error) {
        next(error);
    }
};

// ==================== SITES EXCEL MANAGEMENT ====================

const XLSX = require('xlsx');

/**
 * @route   GET /api/admin/sites/download-format
 * @desc    Download the Excel format template for site uploads
 * @access  Admin only
 */
const downloadSiteFormat = async (req, res, next) => {
    try {
        const filePath = path.join(__dirname, '../public/templates/new_site_format.xlsx');

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Template file not found'
            });
        }

        // Set explicit headers for proper file download
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="new_site_format.xlsx"');

        res.download(filePath, 'new_site_format.xlsx');
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/admin/sites/upload-excel-preview
 * @desc    Upload Excel file, parse it, and return preview (no DB changes)
 * @access  Admin only
 */
const previewSitesExcel = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Excel file is required'
            });
        }

        // Check file extension
        const ext = path.extname(req.file.originalname).toLowerCase();
        if (ext !== '.xlsx' && ext !== '.xls') {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Only Excel files (.xlsx, .xls) are allowed'
            });
        }

        // Read Excel file
        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet);

        // Clean up uploaded file immediately (we already read it)
        fs.unlinkSync(req.file.path);

        if (data.length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Excel file is empty'
            });
        }

        const validSites = [];
        const conflicts = [];
        const errors = [];

        // Helper to get value with various key variations
        const getVal = (row, keys) => {
            for (const key of keys) {
                if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
                const trimmedWithSpaces = Object.keys(row).find(k => k.trim() === key.trim());
                if (trimmedWithSpaces && row[trimmedWithSpaces] !== undefined && row[trimmedWithSpaces] !== null && row[trimmedWithSpaces] !== '') {
                    return row[trimmedWithSpaces];
                }
            }
            return null;
        };

        for (let i = 0; i < data.length; i++) {
            const row = data[i];
            const rowNum = i + 2;

            try {
                const site = {
                    root_domain: getVal(row, ['Root Domain', 'root_domain', 'Domain', 'domain']) || '',
                    niche: getVal(row, ['Website Niche', 'website_niche', 'Niche', 'niche']) || '',
                    category: getVal(row, ['Main Category', 'Category', 'category']) || '',
                    da: getVal(row, ['DA', 'da']),
                    dr: getVal(row, ['DR', 'dr']),
                    traffic: getVal(row, ['Traffic', 'traffic']),
                    traffic_source: getVal(row, ['Traffic', 'traffic', 'Traffic Source', 'traffic_source']),
                    rd: getVal(row, ['RD', 'rd']),
                    gp_price: getVal(row, ['GP Agreed Price', 'GP Price', 'gp_price', 'GP']) || '',
                    niche_edit_price: getVal(row, ['NE Agreed Price', 'Niche Agreed Price', 'Niche Price', 'Niche Edit Price', 'niche_edit_price', 'NE Price']) || '',
                    fc_gp: getVal(row, ['FC GP', 'FCGP', 'fc_gp']),
                    fc_ne: getVal(row, ['FC NE', 'FCNE', 'fc_ne']),
                    spam_score: getVal(row, ['Spam Score', 'Spam', 'spam_score']),
                    word_count: getVal(row, ['Word Count', 'word_count']),
                    sample_url: getVal(row, ['Sample post', 'Sample URL', 'sample_url']) || '',
                    email: getVal(row, ['Email', 'email']) || '',
                    whatsapp: getVal(row, ['whatsapp', 'WhatsApp', 'Whatsapp']) || '',
                    skype: getVal(row, ['skype', 'Skype']) || '',
                    paypal_id: getVal(row, ['Paypal id', 'PayPal ID', 'PayPal', 'paypal_id']) || '',
                    country_source: getVal(row, ['Country Source', 'Country', 'country_source']) || '',
                    website_niche: getVal(row, ['Website Niche', 'website_niche', 'Niche']) || '',
                    website_status: getVal(row, ['Website Status', 'website_status']) || '',
                    marked_sponsor: getVal(row, ['Marked Sponsor', 'marked_sponsor']) || '',
                    accept_grey_niche: getVal(row, ['Grey Niche', 'grey_niche', 'accept_grey_niche']) || '',
                    total_time: getVal(row, ['Total time', 'total_time']),
                    href_url: getVal(row, ['Href url', 'href_url']) || '',
                    site_status: getVal(row, ['Status', 'status']) || '1',
                    domain_type: getVal(row, ['Domain Type', 'domain_type']) || '',
                    association_type: getVal(row, ['Association Type', 'association_type']) || ''
                };

                if (!site.root_domain) {
                    errors.push(`Row ${rowNum}: Missing domain`);
                    continue;
                }

                // Check if domain already exists in DB
                const existingCheck = await query(
                    'SELECT id, root_domain, email, gp_price, niche_edit_price, da, dr, niche FROM new_sites WHERE root_domain = $1 LIMIT 1',
                    [site.root_domain]
                );

                if (existingCheck.rows.length > 0) {
                    // Conflict: domain already exists
                    conflicts.push({
                        newSite: site,
                        existingSite: existingCheck.rows[0]
                    });
                } else {
                    // New site, valid to add
                    validSites.push(site);
                }
            } catch (rowError) {
                errors.push(`Row ${rowNum}: ${rowError.message}`);
            }
        }

        res.json({
            validSites,
            conflicts,
            errors
        });
    } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        next(error);
    }
};

/**
 * @route   POST /api/admin/sites/upload-excel-confirm
 * @desc    Confirm and persist sites after preview (handles conflict resolution)
 * @access  Admin only
 */
const confirmSitesExcel = async (req, res, next) => {
    try {
        const { sites } = req.body;

        if (!sites || !Array.isArray(sites) || sites.length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'No sites to import'
            });
        }

        let inserted = 0;
        let replaced = 0;
        let ignored = 0;
        const importErrors = [];

        // Helper to resolve blogger ID from email
        const resolveBloggerId = async (email) => {
            if (email && email.trim()) {
                const userLookup = await query(
                    "SELECT id FROM users WHERE email = $1 LIMIT 1",
                    [email.trim()]
                );
                if (userLookup.rows.length > 0) {
                    return userLookup.rows[0].id;
                }
            }
            return null;
        };

        for (const site of sites) {
            try {
                // If site has a resolution field, it came from a conflict
                const resolution = site.resolution || 'ADD'; // default: treat as new

                if (resolution === 'IGNORE') {
                    ignored++;
                    continue;
                }

                if (!site.root_domain) {
                    importErrors.push(`Missing domain for site`);
                    continue;
                }

                const parseNum = (val) => {
                    if (val === null || val === undefined || val === '' || String(val).trim().toUpperCase() === 'N/A') return null;
                    // Extract numbers, decimal points from string like "72 Hours", "$10"
                    const parsed = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
                    return isNaN(parsed) ? null : parsed;
                };

                const da = parseNum(site.da);
                const dr = parseNum(site.dr);
                const traffic = parseNum(site.traffic);
                const rd = parseNum(site.rd);
                const fc_gp = parseNum(site.fc_gp);
                const fc_ne = parseNum(site.fc_ne);
                const total_time = parseNum(site.total_time);

                if (resolution === 'REPLACE') {
                    // Preserve existing blogger ID before deleting
                    const existingRow = await query(
                        'SELECT uploaded_user_id FROM new_sites WHERE root_domain = $1 LIMIT 1',
                        [site.root_domain]
                    );
                    const existingBloggerId = existingRow.rows[0]?.uploaded_user_id;

                    // Retain existing site but mark as Rejected
                    await query(
                        `UPDATE new_sites 
                         SET website_status = 'Rejected', site_status = '2', updated_at = CURRENT_TIMESTAMP 
                         WHERE root_domain = $1`, 
                        [site.root_domain]
                    );

                    // Resolve blogger: email lookup → existing owner → admin fallback
                    const emailBloggerId = await resolveBloggerId(site.email);
                    const bloggerId = emailBloggerId || existingBloggerId || req.user.id;

                    // Re-insert with correct blogger ID
                    await query(
                        `INSERT INTO new_sites (
                            root_domain, niche, category, da, dr, traffic, traffic_source, rd, 
                            gp_price, niche_edit_price, fc_gp, fc_ne, spam_score, word_count, 
                            sample_url, email, whatsapp, skype, paypal_id, country_source,
                            website_niche, website_status, marked_sponsor, accept_grey_niche,
                            total_time, href_url, site_status, uploaded_user_id,
                            domain_type, association_type, created_at, updated_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                        [
                            site.root_domain, site.niche || '', site.category || '',
                            da, dr, traffic, site.traffic_source, rd,
                            site.gp_price || '', site.niche_edit_price || '', fc_gp, fc_ne,
                            site.spam_score, site.word_count, site.sample_url || '', site.email || '',
                            site.whatsapp || '', site.skype || '', site.paypal_id || '', site.country_source || '',
                            site.website_niche || '', site.website_status || '', site.marked_sponsor || '',
                            site.accept_grey_niche || '', total_time, site.href_url || '',
                            site.site_status || '1', bloggerId,
                            site.domain_type || '', site.association_type || ''
                        ]
                    );
                    replaced++;
                    continue; // Skip the rest — REPLACE is fully handled
                }

                // Check if domain exists (for ADD or new sites)
                const existingCheck = await query(
                    'SELECT id FROM new_sites WHERE root_domain = $1 LIMIT 1',
                    [site.root_domain]
                );

                if (existingCheck.rows.length > 0 && resolution !== 'ADD') {
                    // Update existing (shouldn't normally reach here, but safety net)
                    await query(
                        `UPDATE new_sites SET
                            niche = COALESCE(NULLIF($2, ''), niche),
                            category = COALESCE(NULLIF($3, ''), category),
                            da = COALESCE($4, da),
                            dr = COALESCE($5, dr),
                            traffic = COALESCE($6, traffic),
                            traffic_source = COALESCE($7, traffic_source),
                            rd = COALESCE($8, rd),
                            gp_price = COALESCE(NULLIF($9, ''), gp_price),
                            niche_edit_price = COALESCE(NULLIF($10, ''), niche_edit_price),
                            fc_gp = COALESCE($11, fc_gp),
                            fc_ne = COALESCE($12, fc_ne),
                            spam_score = COALESCE($13, spam_score),
                            word_count = COALESCE($14, word_count),
                            sample_url = COALESCE(NULLIF($15, ''), sample_url),
                            email = COALESCE(NULLIF($16, ''), email),
                            whatsapp = COALESCE(NULLIF($17, ''), whatsapp),
                            skype = COALESCE(NULLIF($18, ''), skype),
                            paypal_id = COALESCE(NULLIF($19, ''), paypal_id),
                            country_source = COALESCE(NULLIF($20, ''), country_source),
                            website_niche = COALESCE(NULLIF($21, ''), website_niche),
                            website_status = COALESCE(NULLIF($22, ''), website_status),
                            marked_sponsor = COALESCE(NULLIF($23, ''), marked_sponsor),
                            accept_grey_niche = COALESCE(NULLIF($24, ''), accept_grey_niche),
                            total_time = COALESCE($25, total_time),
                            href_url = COALESCE(NULLIF($26, ''), href_url),
                            updated_at = CURRENT_TIMESTAMP
                        WHERE root_domain = $1`,
                        [
                            site.root_domain, site.niche || '', site.category || '',
                            da, dr, traffic, site.traffic_source, rd,
                            site.gp_price || '', site.niche_edit_price || '', fc_gp, fc_ne,
                            site.spam_score, site.word_count, site.sample_url || '', site.email || '',
                            site.whatsapp || '', site.skype || '', site.paypal_id || '', site.country_source || '',
                            site.website_niche || '', site.website_status || '', site.marked_sponsor || '',
                            site.accept_grey_niche || '', total_time, site.href_url || ''
                        ]
                    );
                    replaced++;
                } else {
                    // Insert new site — resolve blogger from email
                    const emailBloggerId = await resolveBloggerId(site.email);
                    const bloggerId = emailBloggerId || req.user.id;

                    await query(
                        `INSERT INTO new_sites (
                            root_domain, niche, category, da, dr, traffic, traffic_source, rd, 
                            gp_price, niche_edit_price, fc_gp, fc_ne, spam_score, word_count, 
                            sample_url, email, whatsapp, skype, paypal_id, country_source,
                            website_niche, website_status, marked_sponsor, accept_grey_niche,
                            total_time, href_url, site_status, uploaded_user_id,
                            domain_type, association_type, created_at, updated_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                        [
                            site.root_domain, site.niche || '', site.category || '',
                            da, dr, traffic, site.traffic_source, rd,
                            site.gp_price || '', site.niche_edit_price || '', fc_gp, fc_ne,
                            site.spam_score, site.word_count, site.sample_url || '', site.email || '',
                            site.whatsapp || '', site.skype || '', site.paypal_id || '', site.country_source || '',
                            site.website_niche || '', site.website_status || '', site.marked_sponsor || '',
                            site.accept_grey_niche || '', total_time, site.href_url || '',
                            site.site_status || '1', bloggerId,
                            site.domain_type || '', site.association_type || ''
                        ]
                    );
                    inserted++;
                }
            } catch (rowError) {
                importErrors.push(`${site.root_domain || 'Unknown'}: ${rowError.message}`);
            }
        }

        res.json({
            message: 'Import completed successfully',
            stats: {
                inserted,
                replaced,
                ignored,
                errors: importErrors
            }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/admin/sites/upload-excel
 * @desc    Legacy: Upload and import sites from Excel file (direct insert)
 * @access  Admin only
 */
const uploadSitesExcel = async (req, res, next) => {
    // Redirect to the preview flow
    return previewSitesExcel(req, res, next);
};

// ==================== CREATE ACCOUNT FROM SITES ====================

const bcrypt = require('bcryptjs');

/**
 * @route   GET /api/admin/sites/pending-accounts
 * @desc    Get sites with emails that don't have blogger accounts yet
 * @access  Admin only
 */
const getSitesForAccountCreation = async (req, res, next) => {
    try {
        // Get unique emails from new_sites that are NOT in users table
        const result = await query(`
            SELECT 
                ns.email,
                COUNT(ns.id) as site_count,
                ARRAY_AGG(DISTINCT ns.root_domain) as domains,
                MAX(ns.whatsapp) as whatsapp,
                MAX(ns.skype) as skype,
                MAX(ns.da::text) as da,
                MAX(ns.dr::text) as dr,
                MAX(ns.gp_price) as gp_price,
                MAX(ns.niche_edit_price) as niche_edit_price
            FROM new_sites ns
            WHERE ns.email IS NOT NULL 
              AND ns.email != ''
              AND LOWER(ns.email) NOT IN (
                  SELECT LOWER(u.email) FROM users u WHERE u.email IS NOT NULL
              )
            GROUP BY ns.email
            ORDER BY site_count DESC, ns.email
        `);

        res.json({
            count: result.rows.length,
            pending: result.rows.map(row => ({
                email: row.email,
                siteCount: parseInt(row.site_count),
                domains: row.domains || [],
                whatsapp: row.whatsapp || '',
                skype: row.skype || '',
                da: row.da || '',
                dr: row.dr || '',
                gpPrice: row.gp_price || '',
                nicheEditPrice: row.niche_edit_price || ''
            }))
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/admin/sites/create-accounts
 * @desc    Create blogger accounts from pending site emails
 * @access  Admin only
 */
const createAccountsFromSites = async (req, res, next) => {
    try {
        const { emails } = req.body;

        if (!emails || !Array.isArray(emails) || emails.length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Please provide an array of emails'
            });
        }

        const defaultPassword = '12345678';
        const hashedPassword = await bcrypt.hash(defaultPassword, 10);

        const createdAccounts = [];
        const errors = [];

        for (const email of emails) {
            try {
                // Check if user already exists
                const existingUser = await query(
                    'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
                    [email]
                );

                if (existingUser.rows.length > 0) {
                    errors.push(`${email}: Account already exists`);
                    continue;
                }

                // Get site data for this email (for whatsapp, skype etc.)
                const siteData = await query(`
                    SELECT whatsapp, skype, paypal_id 
                    FROM new_sites 
                    WHERE LOWER(email) = LOWER($1) 
                    LIMIT 1
                `, [email]);

                const site = siteData.rows[0] || {};
                const name = email.split('@')[0]; // Use email prefix as name

                // Create blogger account
                const userResult = await query(`
                    INSERT INTO users (name, email, password, role, status, whatsapp, skype, created_at, updated_at)
                    VALUES ($1, $2, $3, 'vendor', 1, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    RETURNING id, name, email
                `, [name, email.toLowerCase(), hashedPassword, site.whatsapp || '', site.skype || '']);

                const newUser = userResult.rows[0];

                // Create wallet for user
                await query(
                    'INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT DO NOTHING',
                    [newUser.id]
                );

                // Update all sites with this email to link to the new blogger
                await query(`
                    UPDATE new_sites 
                    SET uploaded_user_id = $1, updated_at = CURRENT_TIMESTAMP 
                    WHERE LOWER(email) = LOWER($2)
                `, [newUser.id, email]);

                createdAccounts.push({
                    id: newUser.id,
                    name: newUser.name,
                    email: newUser.email
                });

            } catch (err) {
                errors.push(`${email}: ${err.message}`);
            }
        }

        res.json({
            message: `Successfully created ${createdAccounts.length} accounts`,
            created: createdAccounts.length,
            failed: errors.length,
            accounts: createdAccounts,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        next(error);
    }
};
// ==================== PENDING BULK REQUESTS (Admin) ====================

/**
 * @route   GET /api/admin/sites/pending-bulk
 * @desc    Get all pending bulk upload requests from bloggers
 * @access  Admin only
 */
const getPendingBulkRequests = async (req, res, next) => {
    try {
        const status = req.query.status || 'all';
        let statusFilter = '';

        if (status !== 'all') {
            statusFilter = `WHERE bur.status = '${status}'`;
        }

        const result = await query(`
            SELECT 
                bur.id,
                bur.blogger_id,
                bur.file_name,
                bur.file_path,
                bur.status,
                bur.created_at,
                bur.updated_at,
                u.name as blogger_name,
                u.email as blogger_email
            FROM bulk_upload_requests bur
            LEFT JOIN users u ON bur.blogger_id = u.id
            ${statusFilter}
            ORDER BY bur.created_at DESC
        `);

        res.json({
            count: result.rows.length,
            requests: result.rows
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/admin/sites/pending-bulk/:id/download
 * @desc    Download a bulk upload file
 * @access  Admin only
 */
const downloadBulkFile = async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(`
            SELECT file_path, file_name FROM bulk_upload_requests WHERE id = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Bulk upload request not found'
            });
        }

        const { file_path, file_name } = result.rows[0];

        if (!fs.existsSync(file_path)) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'File not found on server'
            });
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${file_name}"`);
        res.download(file_path, file_name);
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/sites/pending-bulk/:id/accept
 * @desc    Accept a bulk upload request
 * @access  Admin only
 */
const acceptBulkRequest = async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(`
            UPDATE bulk_upload_requests 
            SET status = 'accepted', updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING id, file_name, status, blogger_id
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Bulk upload request not found'
            });
        }

        res.json({
            message: 'Bulk upload request accepted',
            request: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/sites/pending-bulk/:id/reject
 * @desc    Reject a bulk upload request
 * @access  Admin only
 */
const rejectBulkRequest = async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(`
            UPDATE bulk_upload_requests 
            SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING id, file_name, status, blogger_id
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Bulk upload request not found'
            });
        }

        res.json({
            message: 'Bulk upload request rejected',
            request: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/admin/sites/list
 * @desc    Get all websites/sites for admin view (with pagination) - same data as manager
 * @access  Admin only
 */
const getWebsitesList = async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        // Build dynamic WHERE conditions as an array
        const conditions = [`(ns.delete_site IS NULL OR ns.delete_site = 0)`];
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

        // Dropdown Filters
        if (req.query.filter_website_status) {
            conditions.push(`ns.site_status = $${paramIndex}`);
            const val = req.query.filter_website_status === 'Approved' ? '1' : req.query.filter_website_status === 'Rejected' ? '2' : '0';
            queryParams.push(val);
            paramIndex++;
        }
        if (req.query.filter_status && !req.query.filter_website_status) {
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
 * @route   GET /api/admin/sites/deleted-list
 * @desc    Get all deleted websites/sites for admin view (with pagination)
 * @access  Admin only
 */
const getDeletedWebsitesList = async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        // Build dynamic WHERE conditions as an array
        const conditions = [`ns.delete_site = 1`];
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

        // Dropdown Filters
        if (req.query.filter_website_status) {
            conditions.push(`ns.site_status = $${paramIndex}`);
            const val = req.query.filter_website_status === 'Approved' ? '1' : req.query.filter_website_status === 'Rejected' ? '2' : '0';
            queryParams.push(val);
            paramIndex++;
        }
        if (req.query.filter_status && !req.query.filter_website_status) {
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
 * @route   PUT /api/admin/sites/:id/delete
 * @desc    Soft delete a website
 * @access  Admin only
 */
const deleteWebsite = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Check for active/in-process orders using this site
        const activeOrdersResult = await query(
            `SELECT COUNT(DISTINCT no.id) as active_orders
             FROM new_order_process_details nopd
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             JOIN new_orders no ON nop.new_order_id = no.id
             WHERE nopd.new_site_id = $1
               AND (nopd.submit_url IS NULL OR nopd.submit_url = '')
               AND nop.status NOT IN (5, 11)`,
            [id]
        );

        const activeCount = parseInt(activeOrdersResult.rows[0].active_orders);
        if (activeCount > 0) {
            return res.status(400).json({
                message: `Cannot delete this site. There ${activeCount === 1 ? 'is' : 'are'} ${activeCount} active order(s) currently in process with this site. Please complete or remove these orders first.`
            });
        }

        const result = await query(
            `UPDATE new_sites 
             SET delete_site = 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING id, root_domain`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Website not found' });
        }

        res.json({
            message: 'Website marked as deleted successfully',
            site: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/sites/:id/restore
 * @desc    Restore a soft-deleted website
 * @access  Admin only
 */
const restoreWebsite = async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(
            `UPDATE new_sites 
             SET delete_site = 0, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1
             RETURNING id, root_domain`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Website not found' });
        }

        res.json({
            message: 'Website restored successfully',
            site: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/admin/careers
 * @desc    Get all career positions
 * @access  Admin only
 */
const getCareers = async (req, res, next) => {
    try {
        const result = await query(
            `SELECT id, title, experience, qualification, skills, active as is_active, created_at, updated_at
             FROM careers
             ORDER BY created_at DESC`
        );
        res.json({ careers: result.rows });
    } catch (error) {
        // If table doesn't exist, create it
        if (error.code === '42P01') {
            await query(`
                CREATE TABLE IF NOT EXISTS careers (
                    id SERIAL PRIMARY KEY,
                    title VARCHAR(255) NOT NULL,
                    experience VARCHAR(100),
                    qualification TEXT,
                    skills TEXT,
                    is_active BOOLEAN DEFAULT true,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            res.json({ careers: [] });
        } else {
            next(error);
        }
    }
};

/**
 * @route   POST /api/admin/careers
 * @desc    Create a new career position
 * @access  Admin only
 */
const createCareer = async (req, res, next) => {
    try {
        const { title, experience, qualification, skills, is_active = true } = req.body;
        const active = is_active;

        if (!title) {
            return res.status(400).json({ message: 'Title is required' });
        }

        // Ensure table exists
        await query(`
            CREATE TABLE IF NOT EXISTS careers (
                id SERIAL PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                experience VARCHAR(100),
                qualification TEXT,
                skills TEXT,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const result = await query(
            `INSERT INTO careers (title, experience, qualification, skills, active)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [title, experience, qualification, skills, is_active]
        );

        res.status(201).json({
            message: 'Career created successfully',
            career: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/admin/careers/:id
 * @desc    Get a single career by ID
 * @access  Admin only
 */
const getCareerById = async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await query(
            `SELECT id, title, experience, qualification, skills, active as is_active, created_at, updated_at
             FROM careers WHERE id = $1`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Career not found' });
        }
        res.json({ career: result.rows[0] });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/careers/:id
 * @desc    Update a career
 * @access  Admin only
 */
const updateCareer = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { title, experience, qualification, skills, is_active } = req.body;

        if (!title) {
            return res.status(400).json({ message: 'Title is required' });
        }

        const result = await query(
            `UPDATE careers 
             SET title = $1, experience = $2, qualification = $3, skills = $4, active = $5, updated_at = CURRENT_TIMESTAMP
             WHERE id = $6
             RETURNING *`,
            [title, experience, qualification, skills, is_active, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Career not found' });
        }

        res.json({
            message: 'Career updated successfully',
            career: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   DELETE /api/admin/careers/:id
 * @desc    Delete a career
 * @access  Admin only
 */
const deleteCareer = async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await query(
            `DELETE FROM careers WHERE id = $1 RETURNING id`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Career not found' });
        }

        res.json({ message: 'Career deleted successfully' });
    } catch (error) {
        next(error);
    }
};

// ==================== FAQs Management ====================

/**
 * @route   GET /api/admin/faqs
 * @desc    Get all FAQs
 * @access  Admin only
 */
const getFaqs = async (req, res, next) => {
    try {
        const result = await query(
            `SELECT id, question, answer, COALESCE(active, true) as is_active, created_at, updated_at
             FROM faqs
             ORDER BY created_at DESC`
        );
        res.json({ faqs: result.rows });
    } catch (error) {
        // Table doesn't exist
        if (error.code === '42P01') {
            await query(`
                CREATE TABLE IF NOT EXISTS faqs (
                    id SERIAL PRIMARY KEY,
                    question TEXT NOT NULL,
                    answer TEXT,
                    active BOOLEAN DEFAULT true,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            res.json({ faqs: [] });
        }
        // Column doesn't exist - add it
        else if (error.code === '42703') {
            try {
                await query(`ALTER TABLE faqs ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);
                // Retry the query
                const result = await query(
                    `SELECT id, question, answer, COALESCE(active, true) as is_active, created_at, updated_at
                     FROM faqs ORDER BY created_at DESC`
                );
                res.json({ faqs: result.rows });
            } catch (alterError) {
                next(alterError);
            }
        } else {
            next(error);
        }
    }
};

/**
 * @route   POST /api/admin/faqs
 * @desc    Create a new FAQ
 * @access  Admin only
 */
const createFaq = async (req, res, next) => {
    try {
        const { question, answer, is_active = true } = req.body;

        if (!question) {
            return res.status(400).json({ message: 'Question is required' });
        }

        await query(`
            CREATE TABLE IF NOT EXISTS faqs (
                id SERIAL PRIMARY KEY,
                question TEXT NOT NULL,
                answer TEXT,
                active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const result = await query(
            `INSERT INTO faqs (question, answer, active)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [question, answer, is_active]
        );

        res.status(201).json({
            message: 'FAQ created successfully',
            faq: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/admin/faqs/:id
 * @desc    Get a single FAQ by ID
 * @access  Admin only
 */
const getFaqById = async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await query(
            `SELECT id, question, answer, active as is_active, created_at, updated_at
             FROM faqs WHERE id = $1`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'FAQ not found' });
        }
        res.json({ faq: result.rows[0] });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/faqs/:id
 * @desc    Update a FAQ
 * @access  Admin only
 */
const updateFaq = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { question, answer, is_active } = req.body;

        if (!question) {
            return res.status(400).json({ message: 'Question is required' });
        }

        const result = await query(
            `UPDATE faqs 
             SET question = $1, answer = $2, active = $3, updated_at = CURRENT_TIMESTAMP
             WHERE id = $4
             RETURNING *`,
            [question, answer, is_active, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'FAQ not found' });
        }

        res.json({
            message: 'FAQ updated successfully',
            faq: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   DELETE /api/admin/faqs/:id
 * @desc    Delete a FAQ
 * @access  Admin only
 */
const deleteFaq = async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await query(
            `DELETE FROM faqs WHERE id = $1 RETURNING id`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'FAQ not found' });
        }
        res.json({ message: 'FAQ deleted successfully' });
    } catch (error) {
        next(error);
    }
};

// ==================== Videos Management ====================

/**
 * @route   GET /api/admin/videos
 * @desc    Get all videos
 * @access  Admin only
 */
const getVideos = async (req, res, next) => {
    try {
        const result = await query(
            `SELECT id, title, link, COALESCE(active, true) as is_active, created_at, updated_at
             FROM videos
             ORDER BY created_at DESC`
        );
        res.json({ videos: result.rows });
    } catch (error) {
        // Table doesn't exist
        if (error.code === '42P01') {
            await query(`
                CREATE TABLE IF NOT EXISTS videos (
                    id SERIAL PRIMARY KEY,
                    title VARCHAR(255) NOT NULL,
                    link TEXT,
                    active BOOLEAN DEFAULT true,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            res.json({ videos: [] });
        }
        // Column doesn't exist - add it
        else if (error.code === '42703') {
            try {
                await query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);
                // Retry the query
                const result = await query(
                    `SELECT id, title, link, COALESCE(active, true) as is_active, created_at, updated_at
                     FROM videos ORDER BY created_at DESC`
                );
                res.json({ videos: result.rows });
            } catch (alterError) {
                next(alterError);
            }
        } else {
            next(error);
        }
    }

};

/**
 * @route   POST /api/admin/videos
 * @desc    Create a new video
 * @access  Admin only
 */
const createVideo = async (req, res, next) => {
    try {
        const { title, link, is_active = true } = req.body;

        if (!title) {
            return res.status(400).json({ message: 'Title is required' });
        }

        await query(`
            CREATE TABLE IF NOT EXISTS videos (
                id SERIAL PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                link TEXT,
                active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const result = await query(
            `INSERT INTO videos (title, link, active)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [title, link, is_active]
        );

        res.status(201).json({
            message: 'Video created successfully',
            video: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/admin/videos/:id
 * @desc    Get a single video by ID
 * @access  Admin only
 */
const getVideoById = async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await query(
            `SELECT id, title, link, active as is_active, created_at, updated_at
             FROM videos WHERE id = $1`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Video not found' });
        }
        res.json({ video: result.rows[0] });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/videos/:id
 * @desc    Update a video
 * @access  Admin only
 */
const updateVideo = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { title, link, is_active } = req.body;

        if (!title) {
            return res.status(400).json({ message: 'Title is required' });
        }

        const result = await query(
            `UPDATE videos 
             SET title = $1, link = $2, active = $3, updated_at = CURRENT_TIMESTAMP
             WHERE id = $4
             RETURNING *`,
            [title, link, is_active, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Video not found' });
        }

        res.json({
            message: 'Video updated successfully',
            video: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   DELETE /api/admin/videos/:id
 * @desc    Delete a video
 * @access  Admin only
 */
const deleteVideo = async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await query(
            `DELETE FROM videos WHERE id = $1 RETURNING id`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Video not found' });
        }

        res.json({ message: 'Video deleted successfully' });
    } catch (error) {
        next(error);
    }
};

// ==================== Countries Management ====================

const DEFAULT_COUNTRIES = [
    { name: 'India', payment_methods: 'bank, qr_code, upi_id' },
    { name: 'Afghanistan', payment_methods: 'paypal' },
    { name: 'Albania', payment_methods: 'paypal' },
    { name: 'Algeria', payment_methods: 'paypal' },
    { name: 'Andorra', payment_methods: 'paypal' },
    { name: 'Angola', payment_methods: 'paypal' },
    { name: 'Antigua and Barbuda', payment_methods: 'paypal' },
    { name: 'Argentina', payment_methods: 'paypal' },
    { name: 'Armenia', payment_methods: 'paypal' },
    { name: 'Australia', payment_methods: 'paypal' },
    { name: 'Austria', payment_methods: 'paypal' },
    { name: 'Azerbaijan', payment_methods: 'paypal' },
    { name: 'Bangladesh', payment_methods: 'paypal' },
    { name: 'Brazil', payment_methods: 'paypal' },
    { name: 'Canada', payment_methods: 'paypal' },
    { name: 'China', payment_methods: 'paypal' },
    { name: 'Colombia', payment_methods: 'paypal' },
    { name: 'Costa Rica', payment_methods: 'paypal' },
    { name: 'Cuba', payment_methods: 'paypal' },
    { name: 'Cyprus', payment_methods: 'paypal' },
    { name: 'Denmark', payment_methods: 'paypal' },
    { name: 'Dominica', payment_methods: 'paypal' },
    { name: 'Egypt', payment_methods: 'paypal' },
    { name: 'Ethiopia', payment_methods: 'paypal' },
    { name: 'France', payment_methods: 'paypal' },
    { name: 'Georgia', payment_methods: 'paypal' },
    { name: 'Germany', payment_methods: 'paypal' },
    { name: 'Ghana', payment_methods: 'paypal' },
    { name: 'Greece', payment_methods: 'paypal' },
    { name: 'Hungary', payment_methods: 'paypal' },
    { name: 'Iceland', payment_methods: 'paypal' },
    { name: 'Indonesia', payment_methods: 'paypal' },
    { name: 'Iran', payment_methods: 'paypal' },
    { name: 'Iraq', payment_methods: 'paypal' },
    { name: 'Ireland', payment_methods: 'paypal' },
    { name: 'Israel', payment_methods: 'paypal' },
    { name: 'Italy', payment_methods: 'paypal' },
    { name: 'Jamaica', payment_methods: 'paypal' },
    { name: 'Japan', payment_methods: 'paypal' },
    { name: 'Jordan', payment_methods: 'paypal' },
    { name: 'Kazakhstan', payment_methods: 'paypal' },
    { name: 'Kenya', payment_methods: 'paypal' },
    { name: 'Kiribati', payment_methods: 'paypal' },
    { name: 'Korea', payment_methods: 'paypal' },
    { name: 'Kosovo', payment_methods: 'paypal' },
    { name: 'Kuwait', payment_methods: 'paypal' },
    { name: 'Kyrgyzstan', payment_methods: 'paypal' },
    { name: 'Laos', payment_methods: 'paypal' },
    { name: 'Latvia', payment_methods: 'paypal' },
    { name: 'Lebanon', payment_methods: 'paypal' },
    { name: 'Lesotho', payment_methods: 'paypal' },
    { name: 'Lew Chew', payment_methods: 'paypal' },
    { name: 'Liberia', payment_methods: 'paypal' },
    { name: 'Libya', payment_methods: 'paypal' },
    { name: 'Liechtenstein', payment_methods: 'paypal' },
    { name: 'Lithuania', payment_methods: 'paypal' },
    { name: 'Luxembourg', payment_methods: 'paypal' },
    { name: 'Malaysia', payment_methods: 'paypal' },
    { name: 'Maldives', payment_methods: 'paypal' },
    { name: 'Mali', payment_methods: 'paypal' },
    { name: 'Malta', payment_methods: 'paypal' },
    { name: 'Marshall Islands', payment_methods: 'paypal' },
    { name: 'Mauritania', payment_methods: 'paypal' },
    { name: 'Mauritius', payment_methods: 'paypal' },
    { name: 'Mexico', payment_methods: 'paypal' },
    { name: 'Micronesia', payment_methods: 'paypal' },
    { name: 'Moldova', payment_methods: 'paypal' },
    { name: 'Monaco', payment_methods: 'paypal' },
    { name: 'Mongolia', payment_methods: 'paypal' },
    { name: 'Montenegro', payment_methods: 'paypal' },
    { name: 'Morocco', payment_methods: 'paypal' },
    { name: 'Mozambique', payment_methods: 'paypal' },
    { name: 'Namibia', payment_methods: 'paypal' },
    { name: 'Nauru', payment_methods: 'paypal' },
    { name: 'Nepal', payment_methods: 'paypal' },
    { name: 'Netherlands', payment_methods: 'paypal' },
    { name: 'New Zealand', payment_methods: 'paypal' },
    { name: 'Nigeria', payment_methods: 'paypal' },
    { name: 'Norway', payment_methods: 'paypal' },
    { name: 'Oman', payment_methods: 'paypal' },
    { name: 'Pakistan', payment_methods: 'paypal' },
    { name: 'Panama', payment_methods: 'paypal' },
    { name: 'Philippines', payment_methods: 'paypal' },
    { name: 'Poland', payment_methods: 'paypal' },
    { name: 'Portugal', payment_methods: 'paypal' },
    { name: 'Qatar', payment_methods: 'paypal' },
    { name: 'Romania', payment_methods: 'paypal' },
    { name: 'Russia', payment_methods: 'paypal' },
    { name: 'Rwanda', payment_methods: 'paypal' },
    { name: 'Saudi Arabia', payment_methods: 'paypal' },
    { name: 'Serbia', payment_methods: 'paypal' },
    { name: 'Singapore', payment_methods: 'paypal' },
    { name: 'South Africa', payment_methods: 'paypal' },
    { name: 'Spain', payment_methods: 'paypal' },
    { name: 'Sri Lanka', payment_methods: 'paypal' },
    { name: 'Sweden', payment_methods: 'paypal' },
    { name: 'Switzerland', payment_methods: 'paypal' },
    { name: 'Syria', payment_methods: 'paypal' },
    { name: 'Tajikistan', payment_methods: 'paypal' },
    { name: 'Tanzania', payment_methods: 'paypal' },
    { name: 'Thailand', payment_methods: 'paypal' },
    { name: 'Turkey', payment_methods: 'paypal' },
    { name: 'Uganda', payment_methods: 'paypal' },
    { name: 'Ukraine', payment_methods: 'paypal' },
    { name: 'United Arab Emirates', payment_methods: 'paypal' },
    { name: 'United Kingdom', payment_methods: 'paypal' },
    { name: 'United States', payment_methods: 'paypal' },
    { name: 'Uzbekistan', payment_methods: 'paypal' },
    { name: 'Vanuatu', payment_methods: 'paypal' },
    { name: 'Venezuela', payment_methods: 'paypal' },
    { name: 'Vietnam', payment_methods: 'paypal' },
    { name: 'Yemen', payment_methods: 'paypal' },
    { name: 'Zambia', payment_methods: 'paypal' },
    { name: 'Zimbabwe', payment_methods: 'paypal' }
];

/**
 * @route   GET /api/admin/countries
 * @desc    Get all countries
 * @access  Admin only
 */
const getCountries = async (req, res, next) => {
    try {
        const result = await query(
            `SELECT id, name, payment_methods, created_at, updated_at
             FROM countries
             ORDER BY name ASC`
        );
        res.json({ countries: result.rows });
    } catch (error) {
        // Table doesn't exist - create and seed
        if (error.code === '42P01') {
            try {
                await query(`
                    CREATE TABLE IF NOT EXISTS countries (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(255) NOT NULL,
                        payment_methods TEXT,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                // Seed with default countries
                for (const country of DEFAULT_COUNTRIES) {
                    await query(
                        `INSERT INTO countries (name, payment_methods) VALUES ($1, $2)`,
                        [country.name, country.payment_methods]
                    );
                }
                const result = await query(`SELECT id, name, payment_methods FROM countries ORDER BY name ASC`);
                res.json({ countries: result.rows });
            } catch (seedError) {
                next(seedError);
            }
        } else {
            next(error);
        }
    }
};

/**
 * @route   POST /api/admin/countries
 * @desc    Create a new country
 * @access  Admin only
 */
const createCountry = async (req, res, next) => {
    try {
        const { name, payment_methods } = req.body;

        if (!name) {
            return res.status(400).json({ message: 'Name is required' });
        }

        const result = await query(
            `INSERT INTO countries (name, payment_methods)
             VALUES ($1, $2)
             RETURNING *`,
            [name, payment_methods || 'paypal']
        );

        res.status(201).json({
            message: 'Country created successfully',
            country: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/admin/countries/:id
 * @desc    Get a single country by ID
 * @access  Admin only
 */
const getCountryById = async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await query(
            `SELECT id, name, payment_methods, created_at, updated_at
             FROM countries WHERE id = $1`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Country not found' });
        }
        res.json({ country: result.rows[0] });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/countries/:id
 * @desc    Update a country
 * @access  Admin only
 */
const updateCountry = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { name, payment_methods } = req.body;

        if (!name) {
            return res.status(400).json({ message: 'Name is required' });
        }

        const result = await query(
            `UPDATE countries 
             SET name = $1, payment_methods = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3
             RETURNING *`,
            [name, payment_methods, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Country not found' });
        }

        res.json({
            message: 'Country updated successfully',
            country: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   DELETE /api/admin/countries/:id
 * @desc    Delete a country
 * @access  Admin only
 */
const deleteCountry = async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await query(
            `DELETE FROM countries WHERE id = $1 RETURNING id`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Country not found' });
        }

        res.json({ message: 'Country deleted successfully' });
    } catch (error) {
        next(error);
    }
};




/**
 * @route   GET /api/admin/bloggers-stats
 * @desc    Get all bloggers with stats (wallet, orders) for admin list
 * @access  Admin only
 */
const getBloggerStats = async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const { name, email, walletMin, walletMax } = req.query;

        // Build WHERE clause
        let whereClause = "WHERE u.role IN ('vendor', 'Vendor', 'Blogger', 'blogger')";
        const params = [];
        let paramIndex = 1;

        if (name) {
            whereClause += ` AND LOWER(u.name) LIKE LOWER($${paramIndex++})`;
            params.push(`%${name}%`);
        }
        if (email) {
            whereClause += ` AND LOWER(u.email) LIKE LOWER($${paramIndex++})`;
            params.push(`%${email}%`);
        }

        // Get total count
        const countResult = await query(`SELECT COUNT(*) as total FROM users u ${whereClause}`, params);
        const total = parseInt(countResult.rows[0].total);

        // Get bloggers with stats
        const result = await query(`
            SELECT 
                u.id, u.name, u.email, u.status as is_active, 
                u.last_login, u.login_count, u.created_at,
                COALESCE(
                    (SELECT SUM(
                        COALESCE(
                            NULLIF(nopd.price, 0), 
                            CASE WHEN ns.niche_edit_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.niche_edit_price::DOUBLE PRECISION ELSE NULL END,
                            CASE WHEN ns.gp_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.gp_price::DOUBLE PRECISION ELSE NULL END,
                            0
                        )
                    )
                     FROM new_order_process_details nopd
                     JOIN new_sites ns ON nopd.new_site_id = ns.id
                     WHERE nopd.vendor_id = u.id 
                       AND nopd.status = 8
                       AND nopd.id NOT IN (
                           SELECT wh.order_detail_id 
                           FROM wallet_histories wh
                           JOIN withdraw_requests wr ON wh.withdraw_request_id = wr.id
                           WHERE wr.status = 1
                             AND wh.order_detail_id IS NOT NULL
                       )
                       AND nopd.id NOT IN (
                           SELECT wh2.order_detail_id
                           FROM wallet_histories wh2
                           WHERE wh2.approved_date IS NOT NULL
                             AND wh2.order_detail_id IS NOT NULL
                       )), 
                    0
                ) as wallet_balance,
                (SELECT COUNT(*) FROM new_order_process_details nopd 
                 WHERE nopd.vendor_id = u.id) as total_orders,
                (SELECT COUNT(*) FROM new_order_process_details nopd 
                 WHERE nopd.vendor_id = u.id AND nopd.status IN (5, 6, 7)) as pending_orders,
                (SELECT COUNT(*) FROM new_order_process_details nopd 
                 WHERE nopd.vendor_id = u.id AND nopd.status = 8) as completed_orders
            FROM users u
            LEFT JOIN wallets w ON u.id = w.user_id
            ${whereClause}
            ORDER BY u.created_at DESC
            LIMIT $${paramIndex++} OFFSET $${paramIndex}
        `, [...params, limit, offset]);

        res.json({
            users: result.rows,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        });
    } catch (error) {
        next(error);
    }
};

// ==================== INVOICE MANAGEMENT ====================

/**
 * @route   GET /api/admin/wallet/invoices/:id
 * @desc    Get invoice detail for a withdrawal request
 * @access  Admin only
 */
const getInvoiceDetail = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Get withdrawal request and user info
        const wrResult = await query(
            `SELECT 
                wr.id,
                wr.user_id,
                wr.status,
                wr.invoice_number,
                wr.invoice_pre,
                wr.created_at,
                wr.updated_at,
                u.name as user_name,
                u.email as user_email,
                u.whatsapp as phone,
                cl.name as country_name
             FROM withdraw_requests wr
             JOIN users u ON wr.user_id = u.id
             LEFT JOIN countries cl ON u.country_id = cl.id
             WHERE wr.id = $1`,
            [id]
        );

        if (wrResult.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Invoice not found'
            });
        }

        const wr = wrResult.rows[0];

        // Get all orders/items linked to this withdrawal
        const itemsResult = await query(
            `SELECT 
                wh.id,
                wh.order_detail_id,
                CASE 
                    WHEN wh.price > 0 THEN wh.price
                    WHEN ns.niche_edit_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.niche_edit_price::DOUBLE PRECISION
                    WHEN ns.gp_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.gp_price::DOUBLE PRECISION
                    ELSE 0
                END as price,
                wh.remarks,
                nopd.submit_url,
                ns.root_domain,
                no.order_id as manual_order_id
             FROM wallet_histories wh
             LEFT JOIN new_order_process_details nopd ON wh.order_detail_id = nopd.id
             LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
             LEFT JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             LEFT JOIN new_orders no ON nop.new_order_id = no.id
             WHERE wh.withdraw_request_id = $1
             ORDER BY wh.created_at DESC`,
            [id]
        );

        // Calculate total
        const totalAmount = itemsResult.rows.reduce((sum, row) => sum + parseFloat(row.price || 0), 0);

        // Format date
        const formatDate = (dateStr) => {
            if (!dateStr) return '';
            const d = new Date(dateStr);
            return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        };

        // Extract the invoice note from the withdrawal request remarks.
        // All items in the same withdrawal request share the same remark, so we can just grab the first non-empty one.
        let invoiceNote = 'Thank you for your business!';
        const validRemarkObj = itemsResult.rows.find(row => row.remarks && row.remarks.trim() !== '');
        if (validRemarkObj) {
            invoiceNote = validRemarkObj.remarks.trim();
        }

        // Format response for frontend AdminInvoiceDetail.jsx
        res.json({
            invoice: {
                number: wr.invoice_pre ? `${wr.invoice_pre}${wr.invoice_number}` : (wr.invoice_number || (100000 + parseInt(wr.id))),
                date: formatDate(wr.created_at),
                paidDate: wr.status === 1 ? formatDate(wr.updated_at) : null,
                status: wr.status,
                statusText: wr.status === 1 ? 'PAID' : wr.status === 2 ? 'REJECTED' : 'PENDING'
            },
            blogger: {
                name: wr.user_name || 'N/A',
                email: wr.user_email || 'N/A',
                phone: wr.phone || 'N/A',
                country: wr.country_name || 'N/A'
            },
            company: {
                name: 'Link Management',
                address: 'Digital Services HQ',
                email: 'support@linkmanagement.com'
            },
            items: itemsResult.rows.map((row) => ({
                id: row.id,
                link: row.submit_url || '',
                orderId: row.manual_order_id || `#${row.order_detail_id}`,
                amount: `$${parseFloat(row.price || 0).toFixed(2)}`
            })),
            total: `$${totalAmount.toFixed(2)}`,
            note: invoiceNote
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/admin/wallet/invoices/:id/pdf
 * @desc    Download invoice as PDF
 * @access  Admin only
 */
const downloadInvoicePdf = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Fetch same data as getInvoiceDetail
        const wrResult = await query(
            `SELECT wr.id, wr.status, wr.invoice_number, wr.invoice_pre, wr.created_at, wr.updated_at,
                    u.name, u.email, u.whatsapp as phone, cl.name as country_name
             FROM withdraw_requests wr
             JOIN users u ON wr.user_id = u.id
             LEFT JOIN countries cl ON u.country_id = cl.id
             WHERE wr.id = $1`,
            [id]
        );

        if (wrResult.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
        const wr = wrResult.rows[0];

        const itemsResult = await query(
            `SELECT 
                CASE 
                    WHEN wh.price > 0 THEN wh.price
                    WHEN ns.niche_edit_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.niche_edit_price::DOUBLE PRECISION
                    WHEN ns.gp_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.gp_price::DOUBLE PRECISION
                    ELSE 0
                END as price,
                nopd.submit_url, 
                ns.root_domain, 
                no.order_id as manual_order_id
             FROM wallet_histories wh
             LEFT JOIN new_order_process_details nopd ON wh.order_detail_id = nopd.id
             LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
             LEFT JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             LEFT JOIN new_orders no ON nop.new_order_id = no.id
             WHERE wh.withdraw_request_id = $1`,
            [id]
        );

        const totalAmount = itemsResult.rows.reduce((sum, row) => sum + parseFloat(row.price || 0), 0);
        const invNum = wr.invoice_pre ? `${wr.invoice_pre}${wr.invoice_number}` : (wr.invoice_number || (100000 + parseInt(id)));

        // Create PDF
        const doc = new PDFDocument({ margin: 50 });
        const filename = `invoice-LM${invNum}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        doc.pipe(res);

        // Header
        doc.fontSize(20).text('INVOICE', { align: 'right' });
        doc.fontSize(10).text(`Invoice #: LM${invNum}`, { align: 'right' });
        doc.text(`Date: ${new Date(wr.created_at).toLocaleDateString()}`, { align: 'right' });
        doc.moveDown();

        // Bill From (Blogger)
        doc.fontSize(12).font('Helvetica-Bold').text('Bill From:');
        doc.fontSize(10).font('Helvetica').text(wr.name);
        doc.text(`Email: ${wr.email}`);
        doc.text(`Phone: ${wr.phone || 'N/A'}`);
        doc.text(`Country: ${wr.country_name || 'N/A'}`);
        doc.moveDown();

        // Bill To (Company)
        doc.fontSize(12).font('Helvetica-Bold').text('Bill To:');
        doc.fontSize(10).font('Helvetica').text('Link Management');
        doc.text('Digital Services HQ');
        doc.text('support@linkmanagement.com');
        doc.moveDown();

        // Items Table Header
        const tableTop = 300;
        doc.fontSize(10).font('Helvetica-Bold');
        doc.text('Service/Link', 50, tableTop);
        doc.text('Order ID', 350, tableTop);
        doc.text('Amount', 480, tableTop, { align: 'right' });

        doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

        // Items
        let y = tableTop + 25;
        doc.font('Helvetica');
        itemsResult.rows.forEach(item => {
            const price = `$${parseFloat(item.price || 0).toFixed(2)}`;
            const link = item.submit_url || item.root_domain || 'N/A';
            const orderId = item.manual_order_id || 'N/A';

            doc.text(link.substring(0, 50), 50, y);
            doc.text(orderId, 350, y);
            doc.text(price, 480, y, { align: 'right' });
            y += 20;
        });

        doc.moveTo(50, y).lineTo(550, y).stroke();
        y += 10;

        // Total
        doc.fontSize(12).font('Helvetica-Bold');
        doc.text('Total', 350, y);
        doc.text(`$${totalAmount.toFixed(2)}`, 480, y, { align: 'right' });

        // Footer
        doc.fontSize(10).font('Helvetica-Oblique').text('Thank you for your business!', 50, 700, { align: 'center' });

        doc.end();
    } catch (error) {
        console.error('PDF Error:', error);
        if (!res.headersSent) {
            next(error);
        }
    }
};

// ==================== USER MANAGEMENT EXTENDED ====================

/**
 * @route   PUT /api/admin/users/:id/reset-password
 * @desc    Reset a user's password to a random generated password
 * @access  Admin only
 */
const resetUserPassword = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Check user exists
        const userResult = await query('SELECT id, name, email FROM users WHERE id = $1', [id]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Generate standard default password
        const newPassword = '12345678'; // 8 char default password

        // Hash password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update user
        await query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [hashedPassword, id]);

        res.json({
            message: 'Password reset successfully',
            newPassword,
            user: userResult.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/users/:id/change-password
 * @desc    Change a user's password to a specific password
 * @access  Admin only
 */
const changeUserPassword = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { password } = req.body;

        if (!password || password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        // Check user exists
        const userResult = await query('SELECT id FROM users WHERE id = $1', [id]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Hash and update password
        const hashedPassword = await bcrypt.hash(password, 10);
        await query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [hashedPassword, id]);

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/admin/users/:id/permissions
 * @desc    Get a user's role and permissions
 * @access  Admin only
 */
const getUserPermissions = async (req, res, next) => {
    try {
        const { id } = req.params;

        const userResult = await query(
            'SELECT id, name, email, role, status as is_active, permissions as ui_permissions FROM users WHERE id = $1',
            [id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const user = userResult.rows[0];

        // Parse JSONB permissions or default to empty object
        const dynamicPermissions = typeof user.ui_permissions === 'string'
            ? JSON.parse(user.ui_permissions || '{}')
            : (user.ui_permissions || {});

        res.json({
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                is_active: user.is_active
            },
            permissions: {
                // Static role-based capabilities
                role: user.role,
                canManageOrders: ['Admin', 'Manager', 'Team'].includes(user.role),
                canManageSites: ['Admin', 'Manager'].includes(user.role),
                canManageUsers: ['Admin'].includes(user.role),
                canViewReports: ['Admin', 'Manager'].includes(user.role),
                canManageWallet: ['Admin'].includes(user.role),
                // Merge in the dynamic UI dashboard permissions
                ...dynamicPermissions
            }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/users/:id/permissions
 * @desc    Update a user's role/permissions
 * @access  Admin only
 */
const updateUserPermissions = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { permissions } = req.body;

        if (!permissions) {
            return res.status(400).json({ message: 'Permissions payload is required' });
        }

        // Check user exists
        const userResult = await query('SELECT id, permissions as current_permissions FROM users WHERE id = $1', [id]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const currentUserPermissions = typeof userResult.rows[0].current_permissions === 'string'
            ? JSON.parse(userResult.rows[0].current_permissions || '{}')
            : (userResult.rows[0].current_permissions || {});

        // If the payload includes a role, attempt to update it
        if (permissions.role) {
            const incomingRole = String(permissions.role).trim().toLowerCase();
            const validRolesMap = {
                'admin': 'admin',
                'manager': 'manager',
                'team': 'team',
                'team member': 'team',
                'writer': 'writer',
                'blogger': 'vendor',
                'accountant': 'accountant'
            };

            if (validRolesMap[incomingRole]) {
                await query(
                    'UPDATE users SET role = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                    [validRolesMap[incomingRole], id]
                );
            } else {
                // If it's totally invalid, we can just optionally ignore the role update part 
                // and proceed with permissions, or strictly fail. Let's strictly fail with a better message.
                return res.status(400).json({ message: `Invalid role provided: ${permissions.role}. System expected one of: Admin, Manager, Team, Writer, Blogger` });
            }
        }

        // Extract UI boolean flags from the incoming payload (ignoring static role capabilities)
        const uiFlags = { ...permissions };
        delete uiFlags.role;
        delete uiFlags.canManageOrders;
        delete uiFlags.canManageSites;
        delete uiFlags.canManageUsers;
        delete uiFlags.canViewReports;
        delete uiFlags.canManageWallet;

        // Merge the incoming UI flags with whatever may already exist in the DB
        const mergedPermissions = { ...currentUserPermissions, ...uiFlags };

        // Save dynamic permissions back to database
        await query(
            'UPDATE users SET permissions = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [JSON.stringify(mergedPermissions), id]
        );

        res.json({ message: 'Permissions updated successfully' });
    } catch (error) {
        next(error);
    }
};

// ==================== BLOGGER PERFORMANCE ====================

/**
 * @route   GET /api/admin/bloggers/:id/performance
 * @desc    Get performance stats for a specific blogger
 * @access  Admin only
 */
const getBloggerPerformance = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Get blogger info with accurate calculated wallet balance matching getBloggerStats
        const userResult = await query(
            `SELECT id, name, email, status as is_active, created_at, last_login, login_count,
                 COALESCE(
                    (SELECT SUM(
                        COALESCE(
                            NULLIF(nopd.price, 0), 
                            CASE WHEN ns.niche_edit_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.niche_edit_price::DOUBLE PRECISION ELSE NULL END,
                            CASE WHEN ns.gp_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.gp_price::DOUBLE PRECISION ELSE NULL END,
                            0
                        )
                    )
                     FROM new_order_process_details nopd
                     JOIN new_sites ns ON nopd.new_site_id = ns.id
                     WHERE nopd.vendor_id = users.id 
                       AND nopd.status = 8
                       AND nopd.id NOT IN (
                           SELECT wh.order_detail_id 
                           FROM wallet_histories wh
                           JOIN withdraw_requests wr ON wh.withdraw_request_id = wr.id
                           WHERE wr.status = 1
                             AND wh.order_detail_id IS NOT NULL
                       )
                       AND nopd.id NOT IN (
                           SELECT wh2.order_detail_id
                           FROM wallet_histories wh2
                           WHERE wh2.approved_date IS NOT NULL
                             AND wh2.order_detail_id IS NOT NULL
                       )), 
                    0
                ) as wallet_balance
             FROM users WHERE id = $1`,
            [id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'Blogger not found' });
        }

        const blogger = userResult.rows[0];

        // Get order stats
        const statsResult = await query(`
            SELECT 
                COUNT(*) as total_orders,
                COUNT(*) FILTER (WHERE nopd.status IN (5, 6, 7)) as pending_orders,
                COUNT(*) FILTER (WHERE nopd.status = 8) as completed_orders,
                COUNT(*) FILTER (WHERE nopd.status IN (9, 10)) as rejected_orders,
                COALESCE(SUM(
                    COALESCE(
                        NULLIF(nopd.price, 0), 
                        CASE WHEN ns.niche_edit_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.niche_edit_price::DOUBLE PRECISION ELSE NULL END,
                        CASE WHEN ns.gp_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.gp_price::DOUBLE PRECISION ELSE NULL END,
                        0
                    )
                ) FILTER (WHERE nopd.status = 8), 0) as total_earnings
            FROM new_order_process_details nopd
            JOIN new_sites ns ON nopd.new_site_id = ns.id
            WHERE nopd.vendor_id = $1
        `, [id]);

        // Get websites count
        const websitesResult = await query(
            'SELECT COUNT(*) as total FROM new_sites WHERE uploaded_user_id = $1',
            [id]
        );

        // Get recent orders using vendor_id for correct assignment
        const recentOrdersResult = await query(`
            SELECT nopd.id, nopd.status, nopd.created_at, nopd.submit_url,
                   ns.root_domain,
                   COALESCE(NULLIF(nopd.price, 0),
                       CASE WHEN ns.niche_edit_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.niche_edit_price::DOUBLE PRECISION ELSE NULL END,
                       CASE WHEN ns.gp_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.gp_price::DOUBLE PRECISION ELSE NULL END,
                       0
                   ) as price
            FROM new_order_process_details nopd
            JOIN new_sites ns ON nopd.new_site_id = ns.id
            WHERE nopd.vendor_id = $1
            ORDER BY nopd.created_at DESC
            LIMIT 10
        `, [id]);

        const stats = statsResult.rows[0] || {};

        // Merge stats into blogger so frontend reads response.blogger.total_orders etc.
        const mergedBlogger = {
            ...blogger,
            total_orders: parseInt(stats.total_orders) || 0,
            pending_orders: parseInt(stats.pending_orders) || 0,
            completed_orders: parseInt(stats.completed_orders) || 0,
            rejected_orders: parseInt(stats.rejected_orders) || 0,
            total_earnings: parseFloat(stats.total_earnings) || 0,
            total_websites: parseInt(websitesResult.rows[0]?.total) || 0,
            wallet_balance: parseFloat(blogger.wallet_balance) || 0
        };

        res.json({
            blogger: mergedBlogger,
            recentOrders: recentOrdersResult.rows
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/admin/profile
 * @desc    Get current admin's profile
 * @access  Admin only
 */
const getProfile = async (req, res, next) => {
    try {
        const result = await query(
            `SELECT id, name, email, gender, mobile_number, profile_image, created_at
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
            created_at: user.created_at
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/admin/profile
 * @desc    Update current admin's profile
 * @access  Admin only
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
 * @route   POST /api/admin/profile/image
 * @desc    Upload admin profile image
 * @access  Admin only
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

module.exports = {
    getAllUsers,
    createUser,
    updateUser,
    deleteUser,
    getAllWebsites,
    getWebsiteById,
    createWebsite,
    uploadWebsitesCSV,
    upload,
    updateWebsite,
    // deleteWebsite, // The original deleteWebsite is likely a hard delete, replacing with soft delete
    getStatistics,
    getAllTasks,
    getAllWithdrawals,
    getAllPriceCharts,
    createPriceChart,
    updatePriceChart,
    deletePriceChart,
    // Wallet Management
    getBloggersWallets,
    getPaymentHistory,
    getWithdrawalRequests,
    getWithdrawalRequestDetail,
    approveWithdrawal,
    rejectWithdrawal,
    // Sites Excel Management
    downloadSiteFormat,
    uploadSitesExcel,
    previewSitesExcel,
    confirmSitesExcel,
    // Create Account From Sites
    getSitesForAccountCreation,
    createAccountsFromSites,
    getWebsitesList,
    getDeletedWebsitesList,
    deleteWebsite, // This is now the soft delete
    restoreWebsite,
    // Pending Bulk Requests
    getPendingBulkRequests,
    downloadBulkFile,
    acceptBulkRequest,
    rejectBulkRequest,
    // Sites List (same as manager)
    // getWebsitesList, // Already listed above
    // Bloggers Stats
    getBloggerStats,
    // Careers Management
    getCareers,
    createCareer,
    getCareerById,
    updateCareer,
    deleteCareer,
    // FAQs Management
    getFaqs,
    createFaq,
    getFaqById,
    updateFaq,
    deleteFaq,
    // Videos Management
    getVideos,
    createVideo,
    getVideoById,
    updateVideo,
    deleteVideo,
    // Countries Management
    getCountries,
    createCountry,
    getCountryById,
    updateCountry,
    deleteCountry,
    // Invoice Management
    getInvoiceDetail,
    downloadInvoicePdf,
    // User Management Extended
    resetUserPassword,
    changeUserPassword,
    getUserPermissions,
    updateUserPermissions,
    impersonateUser,
    // Blogger Performance
    getBloggerPerformance,
    // Profile Management
    getProfile,
    updateProfile,
    uploadProfileImage
};

