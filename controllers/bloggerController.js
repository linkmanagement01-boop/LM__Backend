const fs = require('fs');
const path = require('path');
const Task = require('../models/Task');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Website = require('../models/Website');
const { getAvailableBalance, getUnapprovedCreditsBalance } = require('../utils/walletService');
const { query } = require('../config/database');

/**
 * Blogger Controller - Production Database Compatible
 * Handles Blogger/Vendor operations
 * 
 * Production Schema:
 * - tasks → new_orders + new_order_processes + new_order_process_details
 * - websites → new_sites
 * - blogger_id → vendor_id / uploaded_user_id
 */

// ==================== TASK MANAGEMENT ====================

/**
 * @route   GET /api/blogger/tasks
 * @desc    Get tasks assigned to the blogger (vendor)
 * @access  Blogger only
 * 
 * Production schema: new_order_process_details.vendor_id = blogger's user id
 */
const getMyTasks = async (req, res, next) => {
    try {
        const bloggerId = req.user.id;

        // Direct query to fetch tasks assigned to this vendor/blogger
        const result = await query(
            `SELECT DISTINCT ON (nopd.new_site_id, nop.new_order_id)
                nopd.id as detail_id,
                nopd.new_order_process_id as process_id,
                nopd.new_site_id as site_id,
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
                nopd.reject_reason,
                nopd.created_at as assigned_at,
                ns.root_domain,
                ns.da,
                ns.dr,
                ns.gp_price,
                ns.niche_edit_price as niche_price,
                nop.new_order_id as order_id,
                nop.status as process_status,
                no.order_id as manual_order_id,
                no.client_name,
                no.client_website,
                no.order_type,
                no.category,
                no.message as order_notes,
                COALESCE(no.created_at, nopd.created_at, CURRENT_TIMESTAMP) as order_created_at,
                m.name as manager_name,
                m.email as manager_email
             FROM new_order_process_details nopd
             JOIN new_sites ns ON nopd.new_site_id = ns.id
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             JOIN new_orders no ON nop.new_order_id = no.id
             LEFT JOIN users m ON no.manager_id = m.id
             WHERE nopd.vendor_id = $1
               AND nopd.status != 12
               AND NOT (nopd.status = 7 AND (nopd.submit_url IS NULL OR nopd.submit_url = ''))
             ORDER BY nopd.new_site_id, nop.new_order_id, COALESCE(nopd.created_at, no.created_at) DESC NULLS LAST, nopd.id DESC`,
            [bloggerId]
        );

        // Sort by date manually since DISTINCT ON requires specific sorting
        result.rows.sort((a, b) => new Date(b.order_created_at) - new Date(a.order_created_at));

        // Map to frontend-friendly format
        const tasks = result.rows.map(row => ({
            id: row.detail_id,
            order_id: row.manual_order_id || `ORD-${row.order_id}`,
            process_id: row.process_id,
            site_id: row.site_id,

            // Site details
            root_domain: row.root_domain,
            website_domain: row.root_domain,
            da: row.da,
            dr: row.dr,
            price: row.niche_price || row.gp_price || 0,

            // Order details
            anchor_text: row.anchor,
            target_url: row.target_url,
            post_url: row.post_url,
            option: row.option, // 'insert' or 'replace'
            insert_after: row.insert_after,
            statement: row.statement,
            notes: row.notes,
            upfront_payment: row.upfront_payment,
            doc_urls: row.doc_urls,
            title: row.title,
            upload_doc_file: row.upload_doc_file,

            // Order info
            order_type: row.order_type,
            category: row.category,
            manager_name: row.manager_name,

            // Status - based on detail_status numeric codes
            // 5 = assigned to blogger (pending)
            // 7 = blogger submitted URL (waiting for manager approval)
            // 8 = manager approved/credited (completed)
            // 11 = rejected by manager (for revision)
            // 12 = rejected by blogger (refused to do)
            current_status: (() => {
                const status = row.detail_status;
                if (status === 8) return 'completed';
                // Status 11 = manager rejected (blogger needs to resubmit)
                if (status === 11) return 'rejected';
                
                if (status === 7 || row.submit_url) return 'waiting';
                return 'pending'; // status 5 or assigned but not submitted
            })(),
            submitted_url: row.submit_url,
            detail_status: row.detail_status,
            rejection_reason: row.reject_reason,

            // Dates
            created_at: row.order_created_at,
            assigned_at: row.assigned_at
        }));

        res.json({
            count: tasks.length,
            tasks
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/blogger/tasks/:id
 * @desc    Get specific task details
 * @access  Blogger only
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

        // Ensure blogger can only view their assigned tasks
        if (String(task.assigned_blogger_id) !== String(req.user.id)) {
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
 * @route   POST /api/blogger/tasks/:id/submit-link
 * @desc    Submit live published URL
 * @access  Blogger only
 * 
 * id = new_order_process_details.id (detail_id)
 * Updates submit_url and status to 7 (pending manager verification)
 */
const submitLiveLink = async (req, res, next) => {
    const axios = require('axios');
    const cheerio = require('cheerio');

    try {
        const { id } = req.params; // This is detail_id
        const { live_url } = req.body;
        const bloggerId = req.user.id;

        // Validation
        if (!live_url || live_url.trim().length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Live URL is required'
            });
        }

        // Basic URL validation
        let parsedUrl;
        try {
            parsedUrl = new URL(live_url);
        } catch (e) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Invalid URL format'
            });
        }

        // Verify the detail belongs to this blogger and get order context
        const detailCheck = await query(
            `SELECT nopd.id, nopd.vendor_id, nopd.status, nopd.price,
                    nopd.anchor, nopd.url as target_url,
                    ns.root_domain, ns.niche_edit_price, ns.gp_price,
                    no.client_website
             FROM new_order_process_details nopd
             JOIN new_sites ns ON nopd.new_site_id = ns.id
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             JOIN new_orders no ON nop.new_order_id = no.id
             WHERE nopd.id = $1`,
            [id]
        );

        if (detailCheck.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Task not found'
            });
        }

        const detail = detailCheck.rows[0];

        // Verify task is assigned to this blogger
        if (String(detail.vendor_id) !== String(bloggerId)) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'This task is not assigned to you'
            });
        }

        // ── STEP 1: Domain Matching Validation ──
        const siteRootDomain = (detail.root_domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '');
        const submittedDomain = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');

        if (!submittedDomain.includes(siteRootDomain) && !siteRootDomain.includes(submittedDomain)) {
            return res.status(400).json({
                error: 'Domain Mismatch',
                message: `The submitted URL domain (${submittedDomain}) does not match the required website (${siteRootDomain}). Please submit a URL from the correct website.`
            });
        }

        // ── STEP 2: Save URL immediately so it appears on manager's pending page ──
        // Clear reject_reason on resubmit so manager sees a clean submission
        console.log(`[submitLiveLink] Saving submit_url for detail ${id}: ${live_url}`);
        await query(
            `UPDATE new_order_process_details 
             SET submit_url = $1, status = 7, reject_reason = NULL,
                 link_status = 'Pending', link_check_result = 'Verification in progress',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [live_url, id]
        );

        // Send success response immediately — don't make the blogger wait for scraping
        res.json({
            message: 'Live URL submitted successfully! Waiting for manager approval.',
            detail_id: id,
            root_domain: detail.root_domain,
            submit_url: live_url,
            link_status: 'Pending',
            link_check_result: 'Verification in progress'
        });

        // ── STEP 3: Background link verification (non-blocking) ──
        // Run scraping AFTER the response is sent so it doesn't block the blogger
        const clientWebsite = detail.client_website || detail.target_url || '';
        const anchorText = detail.anchor || '';

        setImmediate(async () => {
            let linkStatus = 'Not Found';
            let checkResult = '';

            try {
                const response = await axios.get(live_url, {
                    timeout: 15000,
                    maxRedirects: 5,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'text/html,application/xhtml+xml'
                    },
                    validateStatus: (status) => status >= 200 && status < 500
                });

                if (response.status === 404) {
                    linkStatus = 'Unverified';
                    checkResult = 'Page returned 404 - Not Found';
                } else if (response.status !== 200) {
                    linkStatus = 'Unverified';
                    checkResult = `Page returned HTTP ${response.status}`;
                } else {
                    const $ = cheerio.load(response.data);
                    let cleanClient = clientWebsite.toLowerCase().replace(/\/$/, '');
                    const clientDomain = cleanClient.replace(/^https?:\/\//, '');

                    let found = false;
                    $('a').each((i, el) => {
                        let href = $(el).attr('href');
                        const text = $(el).text().trim();
                        const rel = $(el).attr('rel') || '';
                        if (!href) return;

                        let cleanHref = href.toLowerCase().replace(/\/$/, '');
                        const hrefDomain = cleanHref.replace(/^https?:\/\//, '');

                        if (hrefDomain.includes(clientDomain) || cleanHref.includes(clientDomain)) {
                            found = true;
                            if (anchorText && anchorText.trim() !== '') {
                                // Normalize: collapse all whitespace (incl. &nbsp;), lowercase
                                const normalizedExpected = anchorText.replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
                                const normalizedActual = text.replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
                                if (normalizedActual.includes(normalizedExpected) ||
                                    normalizedExpected.includes(normalizedActual)) {
                                    linkStatus = 'Live';
                                    checkResult = `Live - ${rel.includes('nofollow') ? 'Nofollow' : 'Dofollow'}`;
                                } else {
                                    linkStatus = 'Issue';
                                    checkResult = 'Anchor Mismatch';
                                }
                            } else {
                                linkStatus = 'Live';
                                checkResult = `Live - ${rel.includes('nofollow') ? 'Nofollow' : 'Dofollow'}`;
                            }
                            return false;
                        }
                    });

                    if (!found) {
                        linkStatus = 'Not Found';
                        checkResult = 'Link not found on page';
                    }
                }
            } catch (scrapeError) {
                linkStatus = 'Error';
                checkResult = scrapeError.code || 'Network Error';
            }

            // Update verification results in background
            try {
                await query(
                    `UPDATE new_order_process_details 
                     SET link_status = $1, link_check_result = $2,
                         last_checked_at = NOW()
                     WHERE id = $3`,
                    [linkStatus, checkResult, id]
                );
                console.log(`[submitLiveLink] Background verification for detail ${id}: ${linkStatus} - ${checkResult}`);
            } catch (bgError) {
                console.error(`[submitLiveLink] Background verification DB update failed for detail ${id}:`, bgError.message);
            }
        });
    } catch (error) {
        next(error);
    }
};

// ==================== WALLET MANAGEMENT ====================

/**
 * @route   GET /api/blogger/wallet
 * @desc    Get wallet balance and transaction history
 * @access  Blogger only
 */
const getWallet = async (req, res, next) => {
    try {
        // Get unapproved credits balance (deposited but not yet withdrawn/approved)
        const unapprovedBalance = await getUnapprovedCreditsBalance(req.user.id);
        const walletBalance = await User.getWalletBalance(req.user.id);
        const availableBalance = await getAvailableBalance(req.user.id);
        const totalWithdrawn = await Transaction.getTotalWithdrawn(req.user.id);
        const pendingWithdrawals = await Transaction.getPendingAmount(req.user.id);

        // Get wallet history - fetch ALL transactions (no limit)
        const walletHistory = await Transaction.getWalletHistory(req.user.id, 10000);

        // Get completed tasks count from new_order_process_details
        const completedTasksResult = await query(
            `SELECT COUNT(DISTINCT nopd.id) as count 
             FROM new_order_process_details nopd
             WHERE nopd.vendor_id = $1 
             AND nopd.status IN (5, 6, 7)`,
            [req.user.id]
        );

        res.json({
            wallet: {
                // Show unapproved credits as the main balance (deposited but not withdrawn)
                current_balance: parseFloat(unapprovedBalance || 0),
                available_balance: parseFloat(availableBalance || 0),
                total_withdrawn: parseFloat(totalWithdrawn || 0),
                pending_withdrawals: parseFloat(pendingWithdrawals || 0)
            },
            statistics: {
                completed_tasks: parseInt(completedTasksResult.rows[0]?.count || 0)
            },
            // Wallet history with: id, amount, root_domain, type, credit_debit, date
            wallet_history: walletHistory
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/blogger/withdrawals/request
 * @desc    Request withdrawal
 * @access  Blogger only
 */
const requestWithdrawal = async (req, res, next) => {
    try {
        const { amount, notes } = req.body;

        // Validation
        if (!amount || amount <= 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Amount must be greater than 0'
            });
        }

        // Get minimum withdrawal amount from config (default 100)
        const minAmount = 100.00;

        if (amount < minAmount) {
            return res.status(400).json({
                error: 'Validation Error',
                message: `Minimum withdrawal amount is ${minAmount}`
            });
        }

        // Check available balance
        const availableBalance = await getAvailableBalance(req.user.id);

        if (amount > availableBalance) {
            return res.status(400).json({
                error: 'Insufficient Balance',
                message: `Available balance: ${availableBalance}. Requested: ${amount}`
            });
        }

        // Create withdrawal request
        const withdrawal = await Transaction.create(req.user.id, amount, notes);

        res.status(201).json({
            message: 'Withdrawal request submitted successfully',
            withdrawal
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/blogger/withdrawals
 * @desc    Get withdrawal history
 * @access  Blogger only
 */
const getWithdrawals = async (req, res, next) => {
    try {
        const withdrawals = await Transaction.findAll({ user_id: req.user.id });

        res.json({
            count: withdrawals.length,
            withdrawals
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/blogger/invoices
 * @desc    Get invoice/payment history (withdrawal invoices with amounts)
 * @access  Blogger only
 */
const getInvoices = async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        // Get total count of withdraw requests
        const countResult = await query(
            'SELECT COUNT(*) as total FROM withdraw_requests WHERE user_id = $1',
            [req.user.id]
        );
        const total = parseInt(countResult.rows[0]?.total || 0);

        // Get withdraw requests with aggregated amount and payment details from wallet_histories
        const invoicesResult = await query(
            `SELECT 
                wr.id,
                wr.invoice_pre,
                wr.invoice_number,
                wr.invoice_file,
                wr.status,
                wr.created_at,
                wr.updated_at,
                COALESCE(SUM(
                    CASE 
                        WHEN wh.price > 0 THEN wh.price
                        WHEN ns.niche_edit_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.niche_edit_price::DOUBLE PRECISION
                        WHEN ns.gp_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.gp_price::DOUBLE PRECISION
                        ELSE 0
                    END
                ), 0) as amount,
                MAX(wh.payment_method) as payment_method,
                MAX(wh.paypal_email) as paypal_email,
                MAX(wh.bank_type) as bank_type,
                MAX(wh.account_number) as account_number,
                MAX(wh.beneficiary_name) as beneficiary_name,
                MAX(wh.ifsc_code) as ifsc_code,
                MAX(wh.bene_bank_name) as bene_bank_name,
                MAX(wh.approved_date) as approved_date,
                MAX(no.order_id) as order_id
             FROM withdraw_requests wr
             LEFT JOIN wallet_histories wh ON wh.withdraw_request_id = wr.id
             LEFT JOIN new_order_process_details nopd ON wh.order_detail_id = nopd.id
             LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
             LEFT JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             LEFT JOIN new_orders no ON nop.new_order_id = no.id
             WHERE wr.user_id = $1
             GROUP BY wr.id, wr.invoice_pre, wr.invoice_number, wr.invoice_file, wr.status, wr.created_at, wr.updated_at
             ORDER BY wr.created_at DESC
             LIMIT $2 OFFSET $3`,
            [req.user.id, limit, offset]
        );

        // Map status to descriptive text
        const statusMap = {
            0: 'Pending',
            1: 'Completed',
            2: 'Processing',
            3: 'Rejected'
        };

        const invoices = invoicesResult.rows.map(row => ({
            id: row.id,
            invoice_number: row.invoice_pre ? `${row.invoice_pre}${row.invoice_number}` : (row.invoice_number || (100000 + parseInt(row.id))),
            invoice_file: row.invoice_file,
            type: 'withdrawal',
            amount: parseFloat(row.amount) || 0,
            status: row.status,
            status_text: statusMap[row.status] || 'Unknown',
            created_at: row.created_at,
            updated_at: row.updated_at,
            // Payment method info
            payment_method: row.payment_method || null,
            paypal_email: row.paypal_email || null,
            bank_details: (row.bank_type || row.account_number || row.beneficiary_name || row.ifsc_code) ? {
                bank_type: row.bank_type || null,
                account_number: row.account_number || null,
                beneficiary_name: row.beneficiary_name || null,
                ifsc_code: row.ifsc_code || null,
                bank_name: row.bene_bank_name || null
            } : null,
            // Paid/approved date
            paid_date: row.status === 1 ? (row.approved_date || row.updated_at) : null,
            // Order info
            order_id: row.order_id || null
        }));

        res.json({
            invoices,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        next(error);
    }
};

// ==================== STATISTICS ====================

/**
 * @route   GET /api/blogger/stats
 * @desc    Get blogger statistics
 * @access  Blogger only
 */
const getStatistics = async (req, res, next) => {
    try {
        // Get task stats from new_order_process_details (vendor assignments)
        const stats = await query(
            `SELECT 
                COUNT(*) FILTER (WHERE nopd.status IN (4, 5)) as pending_tasks,
                COUNT(*) FILTER (WHERE nopd.status IN (6, 7)) as completed_tasks,
                COUNT(*) FILTER (WHERE nopd.status = 5) as under_review,
                COALESCE(SUM(nopd.price), 0) as total_earned
             FROM new_order_process_details nopd
             WHERE nopd.vendor_id = $1`,
            [req.user.id]
        );

        // Get sites count from new_sites
        const sitesCount = await query(
            `SELECT COUNT(*) as count FROM new_sites WHERE uploaded_user_id = $1`,
            [req.user.id]
        );

        res.json({
            statistics: {
                pending_tasks: parseInt(stats.rows[0]?.pending_tasks || 0),
                completed_tasks: parseInt(stats.rows[0]?.completed_tasks || 0),
                under_review: parseInt(stats.rows[0]?.under_review || 0),
                total_earned: parseFloat(stats.rows[0]?.total_earned || 0),
                total_sites: parseInt(sitesCount.rows[0]?.count || 0)
            }
        });
    } catch (error) {
        next(error);
    }
};

// ==================== SITES MANAGEMENT ====================

/**
 * @route   GET /api/blogger/sites
 * @desc    Get blogger's submitted sites with pagination
 * @access  Blogger only
 */
const getMySites = async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        // Get total count
        const countResult = await query(
            'SELECT COUNT(*) as total FROM new_sites WHERE uploaded_user_id = $1',
            [req.user.id]
        );
        const total = parseInt(countResult.rows[0]?.total || 0);

        // Get paginated sites with blogger's email from users table
        const sites = await query(
            `SELECT 
                ns.id,
                ns.root_domain,
                ns.niche as category,
                ns.da,
                ns.dr,
                ns.traffic_source as traffic,
                ns.rd,
                ns.spam_score,
                ns.gp_price,
                ns.niche_edit_price,
                ns.fc_gp,
                ns.fc_ne,
                ns.site_status,
                ns.website_status,
                ns.website_niche,
                ns.sample_url,
                ns.href_url,
                COALESCE(ns.email, u.email) as email,
                ns.paypal_id,
                ns.skype,
                ns.whatsapp,
                ns.country_source,
                ns.created_at,
                ns.updated_at,
                u.name as blogger_name,
                u.email as blogger_email
             FROM new_sites ns
             LEFT JOIN users u ON ns.uploaded_user_id = u.id
             WHERE ns.uploaded_user_id = $1
             ORDER BY ns.created_at DESC
             LIMIT $2 OFFSET $3`,
            [req.user.id, limit, offset]
        );

        res.json({
            sites: sites.rows,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/blogger/sites
 * @desc    Add single site
 * @access  Blogger only
 */
const addSite = async (req, res, next) => {
    try {
        const {
            domain_url, root_domain, category, niche, da, dr, traffic, rd,
            niche_price, gp_price, sample_url, email,
            spam_score, traffic_source, fc_gp, fc_ne, total_time, marked_sponsor, accept_grey
        } = req.body;

        const domainToUse = root_domain || domain_url;

        // Validation
        if (!domainToUse) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Domain URL is required'
            });
        }

        // Check if domain already exists
        const existing = await query(
            'SELECT id FROM new_sites WHERE root_domain = $1',
            [domainToUse]
        );

        if (existing.rows.length > 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'This domain already exists in the system'
            });
        }

        const result = await query(
            `INSERT INTO new_sites (
                root_domain, niche, da, dr, traffic, rd, 
                niche_edit_price, gp_price, site_status, uploaded_user_id,
                sample_url, email, spam_score, traffic_source, fc_gp, fc_ne,
                marked_sponsor, accept_grey_niche, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '1', $9, $10, $11, $12, $13, $14, $15, $16, $17, CURRENT_TIMESTAMP) 
            RETURNING *`,
            [
                domainToUse,
                niche || category || null,
                da || null,
                dr || null,
                traffic || 0,
                rd || 0,
                niche_price || 0,
                gp_price || 0,
                req.user.id,
                sample_url || null,
                email || null,
                spam_score || null,
                traffic_source || null,
                fc_gp || null,
                fc_ne || null,
                marked_sponsor || null,
                accept_grey || null
            ]
        );

        const site = result.rows[0];
        res.status(201).json({
            message: 'Site added successfully',
            site: {
                ...site,
                domain_url: site.root_domain,
                category: site.niche,
                niche_price: site.niche_edit_price
            }
        });
    } catch (error) {
        console.error('Error adding site:', error);
        next(error);
    }
};

/**
 * @route   PUT /api/blogger/sites/:id
 * @desc    Update site details
 * @access  Blogger only (own sites)
 */
const updateSite = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { category, niche, da, dr, traffic, rd, niche_price, gp_price, status, sample_url, email } = req.body;

        // Check site exists and belongs to blogger
        const site = await query(
            'SELECT * FROM new_sites WHERE id = $1 AND uploaded_user_id = $2',
            [id, req.user.id]
        );

        if (site.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Site not found or you do not have permission to edit it'
            });
        }

        const result = await query(
            `UPDATE new_sites SET 
                niche = COALESCE($1, niche),
                da = COALESCE($2, da),
                dr = COALESCE($3, dr),
                traffic = COALESCE($4, traffic),
                rd = COALESCE($5, rd),
                niche_edit_price = COALESCE($6, niche_edit_price),
                gp_price = COALESCE($7, gp_price),
                site_status = COALESCE($8, site_status),
                sample_url = COALESCE($9, sample_url),
                email = COALESCE($10, email),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $11 
            RETURNING *`,
            [niche || category, da, dr, traffic, rd, niche_price, gp_price, status, sample_url, email, id]
        );

        const updatedSite = result.rows[0];
        res.json({
            message: 'Site updated successfully',
            site: {
                ...updatedSite,
                domain_url: updatedSite.root_domain,
                category: updatedSite.niche,
                niche_price: updatedSite.niche_edit_price
            }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   DELETE /api/blogger/sites/:id
 * @desc    Delete site
 * @access  Blogger only (own sites)
 */
const deleteSite = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Check site exists and belongs to blogger
        const site = await query(
            'SELECT * FROM new_sites WHERE id = $1 AND uploaded_user_id = $2',
            [id, req.user.id]
        );

        if (site.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Site not found or you do not have permission to delete it'
            });
        }

        await query('DELETE FROM new_sites WHERE id = $1', [id]);

        res.json({
            message: 'Site deleted successfully'
        });
    } catch (error) {
        next(error);
    }
};

// ==================== NOTIFICATIONS MANAGEMENT ====================

/**
 * @route   GET /api/blogger/notifications
 * @desc    Get blogger's notifications
 * @access  Blogger only
 */
const getNotifications = async (req, res, next) => {
    try {
        const result = await query(
            `SELECT * FROM notifications 
             WHERE notifiable_id = $1 AND notifiable_type = 'App\\Models\\User'
             ORDER BY created_at DESC 
             LIMIT 50`,
            [req.user.id]
        );

        // Count unread notifications
        const unreadCount = await query(
            `SELECT COUNT(*) as count FROM notifications 
             WHERE notifiable_id = $1 AND notifiable_type = 'App\\Models\\User' AND read_at IS NULL`,
            [req.user.id]
        );

        res.json({
            count: result.rows.length,
            unread_count: parseInt(unreadCount.rows[0]?.count || 0),
            notifications: result.rows
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/blogger/notifications/:id/read
 * @desc    Mark notification as read
 * @access  Blogger only
 */
const markNotificationRead = async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(
            `UPDATE notifications 
             SET read_at = CURRENT_TIMESTAMP 
             WHERE id = $1 AND notifiable_id = $2 
             RETURNING *`,
            [id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Notification not found'
            });
        }

        res.json({
            message: 'Notification marked as read',
            notification: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PATCH /api/blogger/notifications/read-all
 * @desc    Mark all notifications as read
 * @access  Blogger only
 */
const markAllNotificationsRead = async (req, res, next) => {
    try {
        await query(
            `UPDATE notifications 
             SET read_at = CURRENT_TIMESTAMP 
             WHERE notifiable_id = $1 AND read_at IS NULL`,
            [req.user.id]
        );

        res.json({
            message: 'All notifications marked as read'
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/blogger/payment-details
 * @desc    Get blogger's payment details including PayPal, Bank, UPI, QR and country info
 * @access  Blogger only
 */
const getPaymentDetails = async (req, res, next) => {
    try {
        const result = await query(
            `SELECT 
                u.paypal_email,
                u.upi_id,
                u.qr_code_image,
                u.bank_type,
                u.beneficiary_account_number,
                u.beneficiary_name,
                u.bene_bank_name,
                u.ifsc_code,
                u.bene_bank_branch_name,
                u.beneficiary_email_id,
                u.customer_reference_number,
                u.country_id,
                cl.name as country_name,
                cl.payment_methods
             FROM users u
             LEFT JOIN countries cl ON u.country_id = cl.id
             WHERE u.id = $1`,
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'User not found'
            });
        }

        const user = result.rows[0];

        // Parse payment_methods from country (stored as JSON array string: '["bank","qr_code","upi_id","paypal"]')
        let availableMethods = ['paypal'];
        if (user.payment_methods) {
            try {
                // Try parsing as JSON first
                availableMethods = JSON.parse(user.payment_methods);
            } catch (e) {
                // Fallback: Split by comma and clean up quotes/brackets if it was malformed
                availableMethods = user.payment_methods
                    .replace(/[\[\]"]/g, '')
                    .split(',')
                    .map(m => m.trim())
                    .filter(m => m);
            }
        }

        res.json({
            paypal_id: user.paypal_email || '',
            upi_id: user.upi_id || '',
            qr_code_image: user.qr_code_image || '',
            bank_details: {
                bank_type: user.bank_type || '',
                beneficiary_account_number: user.beneficiary_account_number || '',
                beneficiary_name: user.beneficiary_name || '',
                bene_bank_name: user.bene_bank_name || '',
                ifsc_code: user.ifsc_code || '',
                bene_bank_branch_name: user.bene_bank_branch_name || '',
                beneficiary_email_id: user.beneficiary_email_id || '',
                customer_reference_number: user.customer_reference_number || ''
            },
            country_id: user.country_id,
            country_name: user.country_name || '',
            available_methods: availableMethods
        });
    } catch (error) {
        next(error);
    }
};


/**
 * @route   PUT /api/blogger/payment-details
 * @desc    Update blogger's payment details (PayPal, Bank, UPI, QR)
 * @access  Blogger only
 */
const updatePaymentDetails = async (req, res, next) => {
    try {
        const {
            paypal_id,
            upi_id,
            qr_code_image,
            bank_type,
            beneficiary_account_number,
            beneficiary_name,
            bene_bank_name,
            ifsc_code,
            bene_bank_branch_name,
            beneficiary_email_id,
            customer_reference_number
        } = req.body;

        // Validation - PayPal ID
        if (paypal_id && paypal_id.trim().length > 0 && paypal_id.length < 3) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'PayPal ID is too short'
            });
        }

        // Validation - UPI ID (should contain @)
        if (upi_id && upi_id.trim().length > 0 && !upi_id.includes('@')) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'UPI ID should be in format: username@upi'
            });
        }

        await query(
            `UPDATE users SET 
                paypal_email = $1,
                upi_id = $2,
                qr_code_image = $3,
                bank_type = $4,
                beneficiary_account_number = $5,
                beneficiary_name = $6,
                bene_bank_name = $7,
                ifsc_code = $8,
                bene_bank_branch_name = $9,
                beneficiary_email_id = $10,
                customer_reference_number = $11,
                updated_at = CURRENT_TIMESTAMP 
             WHERE id = $12`,
            [
                paypal_id || null,
                upi_id || null,
                qr_code_image || null,
                bank_type || null,
                beneficiary_account_number || null,
                beneficiary_name || null,
                bene_bank_name || null,
                ifsc_code || null,
                bene_bank_branch_name || null,
                beneficiary_email_id || null,
                customer_reference_number || null,
                req.user.id
            ]
        );

        res.json({
            message: 'Payment details updated successfully'
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/blogger/withdrawable-orders
     * @desc    Get orders that are completed but not yet withdrawn
     * @access  Blogger only
     * 
     * Returns orders with status 8 (manager approved/credited) that haven't been included in a withdrawal
     */
const getWithdrawableOrders = async (req, res, next) => {
    try {
        const bloggerId = req.user.id;

        // Get completed orders (status 8 = credited by manager) that don't have a wallet history entry 
        // with a withdraw_request_id (meaning they haven't been withdrawn yet)
        // and haven't been approved yet (approved_date IS NULL)
        // Join through wallets table to match how wallet page fetches data
        const result = await query(
            `SELECT 
                nopd.id as detail_id,
                COALESCE(
                    NULLIF(nopd.price, 0), 
                    CASE WHEN ns.niche_edit_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.niche_edit_price::DOUBLE PRECISION ELSE NULL END,
                    CASE WHEN ns.gp_price ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.gp_price::DOUBLE PRECISION ELSE NULL END,
                    0
                ) as price,
                nopd.submit_url,
                nopd.updated_at as date,
                ns.root_domain,
                ns.niche_edit_price,
                ns.gp_price,
                no.order_id,
                no.client_name
             FROM new_order_process_details nopd
             JOIN new_sites ns ON nopd.new_site_id = ns.id
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             JOIN new_orders no ON nop.new_order_id = no.id
             WHERE nopd.vendor_id = $1 
               AND nopd.status = 8
               AND nopd.id NOT IN (
                   -- Exclude orders linked to a Pending or Approved withdrawal request (covers both legacy credit & modern debit entries)
                   SELECT wh.order_detail_id 
                   FROM wallet_histories wh
                   JOIN withdraw_requests wr ON wh.withdraw_request_id = wr.id
                   WHERE wr.status IN (0, 1)  -- 0=Pending, 1=Approved
                     AND wh.order_detail_id IS NOT NULL
               )
               AND nopd.id NOT IN (
                   -- Also exclude orders whose wallet_history has been marked as approved/paid
                   SELECT wh2.order_detail_id
                   FROM wallet_histories wh2
                   WHERE wh2.approved_date IS NOT NULL
                     AND wh2.order_detail_id IS NOT NULL
               )
             ORDER BY nopd.updated_at DESC`,
            [bloggerId]
        );


        const orders = result.rows.map(row => ({
            id: row.detail_id,
            order_id: row.order_id,
            price: parseFloat(row.price) || 0,
            submit_url: row.submit_url,
            root_domain: row.root_domain,
            client_name: row.client_name,
            created_at: row.date
        }));

        // Calculate total available for withdrawal
        const totalAmount = orders.reduce((sum, order) => sum + order.price, 0);

        res.json({
            orders,
            total_count: orders.length,
            total_amount: totalAmount
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/blogger/submit-withdrawal
 * @desc    Submit a withdrawal request for selected orders
 * @access  Blogger only
 */
const submitWithdrawalRequest = async (req, res, next) => {
    try {
        const { order_ids, payment_method } = req.body;
        const bloggerId = req.user.id;

        if (!order_ids || !Array.isArray(order_ids) || order_ids.length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Please select at least one order'
            });
        }

        // Cast all order_ids to integers for consistent comparison
        const intOrderIds = order_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));

        // Filter out orders that already have ANY wallet_history entry linked to an approved/pending withdrawal
        // Covers both legacy (credit with withdraw_request_id) and modern (debit entries) structures
        const alreadyWithdrawnResult = await query(
            `SELECT DISTINCT wh.order_detail_id 
             FROM wallet_histories wh
             WHERE wh.order_detail_id = ANY($1::int[]) 
               AND wh.order_detail_id IS NOT NULL
               AND (
                   -- Modern debit entries
                   wh.type = 'debit'
                   -- Legacy: credit entries linked to an approved/pending withdrawal request
                   OR wh.withdraw_request_id IN (
                       SELECT wr.id FROM withdraw_requests wr WHERE wr.status IN (0, 1)
                   )
                   -- Or entries already marked as paid
                   OR wh.approved_date IS NOT NULL
               )`,
            [intOrderIds]
        );
        const alreadyWithdrawnIds = new Set(alreadyWithdrawnResult.rows.map(r => parseInt(r.order_detail_id, 10)));
        const validOrderIds = intOrderIds.filter(id => !alreadyWithdrawnIds.has(id));

        console.log('[Withdrawal] order_ids:', intOrderIds, 'already_withdrawn:', [...alreadyWithdrawnIds], 'valid:', validOrderIds);

        if (validOrderIds.length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'All selected orders have already been submitted for withdrawal'
            });
        }

        // Get the orders and calculate total amount
        const ordersResult = await query(
            `SELECT nopd.id, nopd.price 
             FROM new_order_process_details nopd
             WHERE nopd.id = ANY($1::int[]) AND nopd.vendor_id = $2 AND nopd.status = 8`,
            [validOrderIds, bloggerId]
        );

        if (ordersResult.rows.length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'No valid orders found for withdrawal'
            });
        }

        const totalAmount = ordersResult.rows.reduce((sum, row) => sum + parseFloat(row.price || 0), 0);

        // Get user's payment details to snapshot at time of withdrawal
        const userPaymentDetails = await query(
            `SELECT 
                paypal_email, upi_id, qr_code_image,
                bank_type, beneficiary_account_number, beneficiary_name,
                bene_bank_name, ifsc_code, bene_bank_branch_name,
                beneficiary_email_id, customer_reference_number,
                ac_holder_name, bank_name, account_number, bank_address, swift_code
             FROM users WHERE id = $1`,
            [bloggerId]
        );

        const userDetails = userPaymentDetails.rows[0] || {};

        // Create withdraw request
        const withdrawResult = await query(
            `INSERT INTO withdraw_requests (user_id, status, created_at) 
             VALUES ($1, 0, CURRENT_TIMESTAMP) 
             RETURNING id`,
            [bloggerId]
        );

        const withdrawRequestId = withdrawResult.rows[0].id;

        // Get wallet ID for this user
        const walletResult = await query(
            'SELECT id FROM wallets WHERE user_id = $1',
            [bloggerId]
        );

        let walletId;
        if (walletResult.rows.length === 0) {
            // Auto-create wallet for this blogger
            const createWallet = await query(
                'INSERT INTO wallets (user_id, balance, created_at) VALUES ($1, 0, CURRENT_TIMESTAMP) RETURNING id',
                [bloggerId]
            );
            walletId = createWallet.rows[0].id;
        } else {
            walletId = walletResult.rows[0].id;
        }


        // Create wallet history entries for each order with payment details snapshot
        let insertedCount = 0;
        for (const orderId of validOrderIds) {
            const order = ordersResult.rows.find(r => parseInt(r.id, 10) === orderId);
            if (order) {
                try {
                    await query(
                        `INSERT INTO wallet_histories (
                            wallet_id, order_detail_id, type, price, status, 
                            payment_method, withdraw_request_id, request_date, created_at,
                            paypal_email, upi_id, qr_code_image,
                            bank_type, beneficiary_account_number, beneficiary_name,
                            bene_bank_name, ifsc_code, bene_bank_branch_name,
                            beneficiary_email_id, customer_reference_number,
                            ac_holder_name, bank_name, account_number, bank_address, swift_code
                         )
                         VALUES ($1, $2, 'debit', $3, 0, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                                 $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
                        [
                            walletId, orderId, order.price, payment_method || 'paypal', withdrawRequestId,
                            userDetails.paypal_email, userDetails.upi_id, userDetails.qr_code_image,
                            userDetails.bank_type, userDetails.beneficiary_account_number, userDetails.beneficiary_name,
                            userDetails.bene_bank_name, userDetails.ifsc_code, userDetails.bene_bank_branch_name,
                            userDetails.beneficiary_email_id, userDetails.customer_reference_number,
                            userDetails.ac_holder_name, userDetails.bank_name, userDetails.account_number,
                            userDetails.bank_address, userDetails.swift_code
                        ]
                    );
                    insertedCount++;
                } catch (insertError) {
                    // Skip duplicate entries gracefully (unique constraint violation)
                    if (insertError.code === '23505') {
                        console.warn(`[Withdrawal] Skipping duplicate wallet_history for order ${orderId}`);
                        continue;
                    }
                    throw insertError; // Re-throw other errors
                }
            }
        }

        res.json({
            message: 'Withdrawal request submitted successfully',
            withdraw_request_id: withdrawRequestId,
            total_amount: totalAmount,
            orders_count: validOrderIds.length
        });
    } catch (error) {
        next(error);
    }
};

// ==================== PROFILE MANAGEMENT ====================

/**
 * @route   GET /api/blogger/profile
 * @desc    Get blogger's complete profile information
 * @access  Blogger only
 */
const getProfile = async (req, res, next) => {
    try {
        const userId = req.user.id;

        // Get user profile with country name
        const result = await query(
            `SELECT 
                u.id, u.name, u.email, u.role, u.status,
                u.whatsapp, u.skype, u.address,
                u.country_id, c.name as country_name,
                u.profile_image,
                u.aadhar_number, u.pancard_number, u.gst_number,
                u.created_at
             FROM users u
             LEFT JOIN countries c ON u.country_id = c.id
             WHERE u.id = $1`,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'User not found'
            });
        }

        const user = result.rows[0];

        // Get wallet balance
        const balance = await getUnapprovedCreditsBalance(userId);

        res.json({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            status: user.status === 1 ? 'Active' : 'Inactive',
            whatsapp: user.whatsapp || '',
            skype: user.skype || '',
            address: user.address || '',
            country_id: user.country_id,
            country_name: user.country_name || '',
            profile_image: user.profile_image || '',
            aadhar_number: user.aadhar_number || '',
            pancard_number: user.pancard_number || '',
            gst_number: user.gst_number || '',
            balance: parseFloat(balance || 0),
            joined_date: user.created_at
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   PUT /api/blogger/profile
 * @desc    Update blogger's profile information
 * @access  Blogger only
 */
const updateProfile = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const {
            name,
            country_id,
            whatsapp,
            skype,
            address,
            aadhar_number,
            pancard_number,
            gst_number
        } = req.body;

        // Validation - Required fields
        if (!name || name.trim().length < 2) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Name is required and must be at least 2 characters'
            });
        }

        if (!country_id) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Country is required'
            });
        }

        if (!whatsapp || whatsapp.trim().length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'WhatsApp number is required'
            });
        }

        if (!skype || skype.trim().length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Skype ID is required'
            });
        }

        if (!address || address.trim().length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Address is required'
            });
        }

        // Check if country is India (country_id = 101 typically, but let's check by name)
        const countryResult = await query(
            'SELECT name FROM countries WHERE id = $1',
            [country_id]
        );

        const isIndia = countryResult.rows.length > 0 &&
            countryResult.rows[0].name.toLowerCase() === 'india';

        // If India, PAN card is required
        if (isIndia && (!pancard_number || pancard_number.trim().length === 0)) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'PAN Card Number is required for Indian users'
            });
        }

        // Update profile
        await query(
            `UPDATE users SET 
                name = $1,
                country_id = $2,
                whatsapp = $3,
                skype = $4,
                address = $5,
                aadhar_number = $6,
                pancard_number = $7,
                gst_number = $8,
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $9`,
            [
                name.trim(),
                country_id,
                whatsapp.trim(),
                skype.trim(),
                address.trim(),
                isIndia ? (aadhar_number || '').trim() : null,
                isIndia ? (pancard_number || '').trim() : null,
                isIndia ? (gst_number || '').trim() : null,
                userId
            ]
        );

        res.json({
            message: 'Profile updated successfully'
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/blogger/profile/image
 * @desc    Upload profile image
 * @access  Blogger only
 */
const uploadProfileImage = async (req, res, next) => {
    try {
        const userId = req.user.id;

        if (!req.file) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'No image file uploaded'
            });
        }

        // The file path from multer
        const imagePath = `/uploads/profiles/${req.file.filename}`;

        // Update user profile_image in database
        await query(
            'UPDATE users SET profile_image = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [imagePath, userId]
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
 * @route   PUT /api/blogger/change-password
 * @desc    Change blogger's password
 * @access  Blogger only
 */
const changePassword = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { old_password, new_password, confirm_password } = req.body;

        // Validation
        if (!old_password || !new_password || !confirm_password) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'All password fields are required'
            });
        }

        if (new_password.length < 8) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'New password must be at least 8 characters'
            });
        }

        if (new_password !== confirm_password) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'New password and confirm password do not match'
            });
        }

        // Get current user password
        const userResult = await query(
            'SELECT password FROM users WHERE id = $1',
            [userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'User not found'
            });
        }

        const bcrypt = require('bcrypt');
        const storedPassword = userResult.rows[0].password;

        // Verify old password
        const isValidPassword = await bcrypt.compare(old_password, storedPassword);
        if (!isValidPassword) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Current password is incorrect'
            });
        }

        // Hash new password and update
        const hashedPassword = await bcrypt.hash(new_password, 10);
        await query(
            'UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [hashedPassword, userId]
        );

        res.json({
            message: 'Password changed successfully'
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/blogger/countries
 * @desc    Get list of available countries from admin's countries
 * @access  Public (used in profile forms)
 */
const getCountries = async (req, res, next) => {
    try {
        const result = await query(
            'SELECT id, name, payment_methods FROM countries ORDER BY name ASC'
        );

        res.json({
            countries: result.rows
        });
    } catch (error) {
        next(error);
    }
};

// ==================== BULK SITES UPLOAD ====================

/**
 * @route   POST /api/blogger/bulk-sites/upload
 * @desc    Upload bulk sites Excel file for admin approval
 * @access  Blogger only
 */
const uploadBulkSitesFile = async (req, res, next) => {
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

        // Store the bulk upload request in database
        const result = await query(`
            INSERT INTO bulk_upload_requests (blogger_id, file_path, file_name, status, created_at)
            VALUES ($1, $2, $3, 'pending', CURRENT_TIMESTAMP)
            RETURNING id, file_name, status, created_at
        `, [req.user.id, req.file.path, req.file.originalname]);

        res.status(201).json({
            message: 'File uploaded successfully! Waiting for admin approval.',
            request: result.rows[0]
        });
    } catch (error) {
        // Clean up file on error
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        next(error);
    }
};

/**
 * @route   GET /api/blogger/bulk-sites/history
 * @desc    Get blogger's bulk upload history
 * @access  Blogger only
 */
const getBulkUploadHistory = async (req, res, next) => {
    try {
        const result = await query(`
            SELECT id, file_name, status, created_at, updated_at
            FROM bulk_upload_requests
            WHERE blogger_id = $1
            ORDER BY created_at DESC
        `, [req.user.id]);

        res.json({
            count: result.rows.length,
            requests: result.rows
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/blogger/tasks/:id/reject
 * @desc    Reject a task assigned by manager - sends back with rejection reason
 * @access  Blogger only
 * 
 * id = new_order_process_details.id (detail_id)
 * Updates status to 11 (rejected) and stores rejection reason
 */
const rejectTask = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { rejection_reason } = req.body;
        const bloggerId = req.user.id;

        // Validation
        if (!rejection_reason || rejection_reason.trim().length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Rejection reason is required'
            });
        }

        // Verify the detail belongs to this blogger
        const detailCheck = await query(
            `SELECT nopd.id, nopd.vendor_id, nopd.status,
                    ns.root_domain
             FROM new_order_process_details nopd
             JOIN new_sites ns ON nopd.new_site_id = ns.id
             WHERE nopd.id = $1`,
            [id]
        );

        if (detailCheck.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Task not found'
            });
        }

        const detail = detailCheck.rows[0];

        // Verify task is assigned to this blogger
        if (String(detail.vendor_id) !== String(bloggerId)) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'This task is not assigned to you'
            });
        }

        // Update the detail with rejection status (12 = blogger rejected) and reason
        // Note: Status 11 = Manager rejected blogger's submission (for revision)
        //       Status 12 = Blogger rejected the assignment (refused to do it)
        await query(
            `UPDATE new_order_process_details 
             SET status = 12, reject_reason = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [rejection_reason, id]
        );

        res.json({
            message: 'Task rejected successfully. Manager will be notified.',
            detail_id: id,
            root_domain: detail.root_domain,
            rejection_reason
        });
    } catch (error) {
        next(error);
    }
};

// ==================== INVOICE DETAIL ====================

/**
 * @route   GET /api/blogger/invoices/:id
 * @desc    Get invoice detail for a specific withdrawal request
 * @access  Blogger only
 */
const getInvoiceDetail = async (req, res, next) => {
    try {
        const { id } = req.params;
        const bloggerId = req.user.id;

        // Get withdrawal request and user info - ensure it belongs to this blogger
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
             WHERE wr.id = $1 AND wr.user_id = $2`,
            [id, bloggerId]
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
            note: 'Thank you for your business!'
        });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/blogger/invoices/:id/pdf
 * @desc    Download invoice as PDF
 * @access  Blogger only
 */
const PDFDocument = require('pdfkit');
const downloadInvoicePdf = async (req, res, next) => {
    try {
        const { id } = req.params;
        const bloggerId = req.user.id;

        // Fetch invoice data - ensure it belongs to this blogger
        const wrResult = await query(
            `SELECT wr.id, wr.status, wr.invoice_number, wr.invoice_pre, wr.created_at, wr.updated_at,
                    u.name, u.email, u.whatsapp as phone, cl.name as country_name
             FROM withdraw_requests wr
             JOIN users u ON wr.user_id = u.id
             LEFT JOIN countries cl ON u.country_id = cl.id
             WHERE wr.id = $1 AND wr.user_id = $2`,
            [id, bloggerId]
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
// ==================== LIVE LINK CHECKER ====================

/**
 * @route   POST /api/blogger/check-link
 * @desc    Check if blogger's submitted URL contains the correct backlink & anchor
 * @access  Blogger only
 */
const checkLinkStatus = async (req, res, next) => {
    try {
        const { detailId, bloggerLink, clientWebsite, anchorText } = req.body;
        const bloggerId = req.user.id;

        if (!bloggerLink) {
            return res.status(400).json({ error: 'Blogger link is required' });
        }

        // Verify the detail belongs to this blogger
        if (detailId) {
            const ownerCheck = await query(
                `SELECT vendor_id FROM new_order_process_details WHERE id = $1`,
                [detailId]
            );
            if (ownerCheck.rows.length > 0 && String(ownerCheck.rows[0].vendor_id) !== String(bloggerId)) {
                return res.status(403).json({ error: 'Not authorized to check this link' });
            }
        }

        const axios = require('axios');
        const cheerio = require('cheerio');

        let linkStatus = 'Not Found';
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
            } else if (clientWebsite) {
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
                            return false; // Found a valid link, no anchor needed
                        } else {
                            // Normalize: collapse all whitespace (incl. &nbsp;), lowercase
                            let expected = anchorText.replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
                            let actual = text.replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
                            
                            // Try img alt for empty links
                            if (actual === '') {
                                const imgAlt = link.find('img').attr('alt');
                                if (imgAlt) actual = imgAlt.replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
                            }

                            // Flexible validation: handles bold, italic, case, whitespace
                            if (actual !== '' && (actual.includes(expected) || expected.includes(actual))) {
                                foundMatchingAnchor = true;
                                finalRel = rel;
                                return false; // Perfect match, break out
                            } else if (actual !== '') {
                                if (!bestMismatchText) bestMismatchText = actual;
                            }
                        }
                    }
                });

                if (foundMatchingAnchor) {
                    linkStatus = 'Live';
                    const classification = finalRel.includes('nofollow') ? 'Nofollow' : 'Dofollow';
                    checkResult = `Live - ${classification}`;
                } else if (foundAnyLink) {
                    linkStatus = 'Issue';
                    checkResult = `Anchor Mismatch (Expected: "${anchorText}", Found: "${bestMismatchText || 'Empty/Image Link'}")`;
                } else {
                    linkStatus = 'Not Found';
                    checkResult = `Link to ${clientDomain} not found on page`;
                }
            } else {
                // No client website to check against, just verify page loads
                linkStatus = 'Live';
                checkResult = 'Page loads OK (no target URL to verify)';
            }

        } catch (error) {
            linkStatus = 'Error';
            checkResult = error.code === 'ECONNREFUSED' ? 'Connection Refused' :
                error.code === 'ETIMEDOUT' ? 'Request Timeout' :
                    error.code === 'ENOTFOUND' ? 'Domain Not Found' :
                        error.message || 'Scraping Error';
        }

        // Update DB if detailId provided
        if (detailId) {
            await query(
                `UPDATE new_order_process_details SET link_status = $1, link_check_result = $2, last_checked_at = NOW() WHERE id = $3`,
                [linkStatus, checkResult, detailId]
            );
        }

        res.json({
            status: linkStatus,
            result: checkResult
        });

    } catch (error) {
        console.error('Error checking link status:', error);
        next(error);
    }
};

module.exports = {
    getMyTasks,
    getTaskById,
    submitLiveLink,
    rejectTask,
    getWallet,
    requestWithdrawal,
    getWithdrawals,
    getInvoices,
    getInvoiceDetail,
    downloadInvoicePdf,
    getStatistics,
    getMySites,
    addSite,
    updateSite,
    deleteSite,
    getNotifications,
    markNotificationRead,
    markAllNotificationsRead,
    getPaymentDetails,
    updatePaymentDetails,
    getWithdrawableOrders,
    submitWithdrawalRequest,
    getProfile,
    updateProfile,
    uploadProfileImage,
    changePassword,
    getCountries,
    // Bulk Sites
    uploadBulkSitesFile,
    getBulkUploadHistory,
    // Live Link Checker
    checkLinkStatus
};

