const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { query, transaction } = require('../config/database');
const { sendPaymentApprovedEmail } = require('./emailService');

/**
 * Wallet Service - Production Database Compatible
 * Handles all wallet-related operations for bloggers/vendors
 * 
 * Production Schema:
 * - wallets table: user_id, wallet, created_at, updated_at
 * - withdraw_requests table: for withdrawal requests
 */

/**
 * Add credit to blogger's wallet
 * Creates a wallet_histories record and updates wallet balance
 * @param {number} bloggerId - User ID of the blogger
 * @param {number} amount - Amount to credit
 * @param {number} orderDetailId - ID from new_order_process_details (for root_domain linkage)
 */
const addCreditToBloggerWallet = async (bloggerId, amount, orderDetailId = null) => {
    try {
        // Use database transaction to ensure atomicity
        const result = await transaction(async (client) => {
            // Check if wallet exists
            const walletCheck = await client.query(
                'SELECT id, balance FROM wallets WHERE user_id = $1',
                [bloggerId]
            );

            let walletId;
            let newBalance;

            if (walletCheck.rows.length === 0) {
                // Create wallet if not exists
                const createResult = await client.query(
                    `INSERT INTO wallets (user_id, balance) 
                     VALUES ($1, $2) 
                     RETURNING id, balance`,
                    [bloggerId, amount]
                );
                walletId = createResult.rows[0].id;
                newBalance = createResult.rows[0].balance;
            } else {
                // Update wallet balance
                walletId = walletCheck.rows[0].id;
                const updateResult = await client.query(
                    `UPDATE wallets 
                     SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP
                     WHERE user_id = $2
                     RETURNING id, balance`,
                    [amount, bloggerId]
                );
                newBalance = updateResult.rows[0].balance;
            }

            // Create wallet_histories entry for transaction table display
            // Links to new_order_process_details via order_detail_id for root_domain
            await client.query(
                `INSERT INTO wallet_histories (wallet_id, order_detail_id, type, price, created_at)
                 VALUES ($1, $2, 'credit', $3, CURRENT_TIMESTAMP)`,
                [walletId, orderDetailId, amount]
            );

            return { wallet_balance: newBalance };
        });

        console.log(`✅ Added ${amount} to blogger ${bloggerId} wallet. New balance: ${result.wallet_balance}`);
        return result;
    } catch (error) {
        console.error('❌ Error adding credit to wallet:', error);
        throw error;
    }
};

/**
 * Deduct amount from blogger's wallet (for withdrawal)
 */
const deductFromWallet = async (bloggerId, amount) => {
    try {
        const result = await transaction(async (client) => {
            // Check current balance
            const balanceResult = await client.query(
                'SELECT wallet FROM wallets WHERE user_id = $1',
                [bloggerId]
            );

            if (balanceResult.rows.length === 0) {
                throw new Error('Blogger wallet not found');
            }

            const currentBalance = parseFloat(balanceResult.rows[0].wallet);

            if (currentBalance < amount) {
                throw new Error('Insufficient balance');
            }

            // Deduct amount
            const updateResult = await client.query(
                `UPDATE wallets 
                 SET wallet = wallet - $1, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = $2 
                 RETURNING id, wallet`,
                [amount, bloggerId]
            );

            return { wallet_balance: updateResult.rows[0].wallet };
        });

        console.log(`✅ Deducted ${amount} from blogger ${bloggerId} wallet. New balance: ${result.wallet_balance}`);
        return result;
    } catch (error) {
        console.error('❌ Error deducting from wallet:', error);
        throw error;
    }
};

/**
 * Get unapproved credits balance - sum of all completed orders that haven't been withdrawn yet
 * This calculates based on completed orders (status=8) to match the withdrawal page
 * Uses site prices since nopd.price may be 0
 * Excludes orders that are part of an approved withdrawal request
 */
const getUnapprovedCreditsBalance = async (bloggerId) => {
    try {
        // Calculate balance from completed orders (status=8) that haven't been withdrawn
        // Exclude orders where:
        // 1. They have a wallet_history with withdraw_request linked to an APPROVED request (status=1)
        // 2. OR they have a wallet_history with approved_date set
        const priceSQL = `
                CASE
                    WHEN LOWER(no.order_type) LIKE '%niche%' OR LOWER(no.order_type) LIKE '%edit%' OR LOWER(no.order_type) LIKE '%insertion%'
                        THEN CASE 
                            WHEN no.fc = 1 AND ns.fc_ne IS NOT NULL AND REGEXP_REPLACE(ns.fc_ne::text, '[^0-9.]', '', 'g') ~ '^[0-9]+(\\.[0-9]+)?$' AND REGEXP_REPLACE(ns.fc_ne::text, '[^0-9.]', '', 'g')::DOUBLE PRECISION > 0
                                THEN REGEXP_REPLACE(ns.fc_ne::text, '[^0-9.]', '', 'g')::DOUBLE PRECISION
                            WHEN REGEXP_REPLACE(COALESCE(ns.niche_edit_price::text,'0'), '[^0-9.]', '', 'g') ~ '^[0-9]+(\\.[0-9]+)?$'
                                THEN REGEXP_REPLACE(ns.niche_edit_price::text, '[^0-9.]', '', 'g')::DOUBLE PRECISION
                            ELSE 0 END
                    ELSE CASE 
                            WHEN no.fc = 1 AND ns.fc_gp IS NOT NULL AND REGEXP_REPLACE(ns.fc_gp::text, '[^0-9.]', '', 'g') ~ '^[0-9]+(\\.[0-9]+)?$' AND REGEXP_REPLACE(ns.fc_gp::text, '[^0-9.]', '', 'g')::DOUBLE PRECISION > 0
                                THEN REGEXP_REPLACE(ns.fc_gp::text, '[^0-9.]', '', 'g')::DOUBLE PRECISION
                            WHEN REGEXP_REPLACE(COALESCE(ns.gp_price::text,'0'), '[^0-9.]', '', 'g') ~ '^[0-9]+(\\.[0-9]+)?$'
                                THEN REGEXP_REPLACE(ns.gp_price::text, '[^0-9.]', '', 'g')::DOUBLE PRECISION
                            ELSE 0 END
                END`;

        const result = await query(
            `SELECT COALESCE(SUM(${priceSQL}), 0) as total
             FROM new_order_process_details nopd
             JOIN new_sites ns ON nopd.new_site_id = ns.id
             JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
             JOIN new_orders no ON nop.new_order_id = no.id
             WHERE nopd.vendor_id = $1 
               AND nopd.status = 8
               AND nopd.id NOT IN (
                   -- Exclude orders that are in an APPROVED withdrawal request
                   SELECT wh.order_detail_id 
                   FROM wallet_histories wh
                   JOIN withdraw_requests wr ON wh.withdraw_request_id = wr.id
                   WHERE wr.status = 1  -- 1 = Approved
                     AND wh.order_detail_id IS NOT NULL
               )
               AND nopd.id NOT IN (
                   -- Also exclude orders with approved_date set on their wallet_history
                   SELECT wh2.order_detail_id
                   FROM wallet_histories wh2
                   WHERE wh2.approved_date IS NOT NULL
                     AND wh2.order_detail_id IS NOT NULL
               )`,
            [bloggerId]
        );

        return parseFloat(result.rows[0]?.total || 0);
    } catch (error) {
        console.error('❌ Error getting unapproved credits balance:', error);
        return 0;
    }
};

/**
 * Get available balance (wallet balance - pending withdrawals)
 */
const getAvailableBalance = async (bloggerId) => {
    try {
        const walletBalance = await User.getWalletBalance(bloggerId);
        const pendingAmount = await Transaction.getPendingAmount(bloggerId);

        return (walletBalance || 0) - (pendingAmount || 0);
    } catch (error) {
        console.error('❌ Error getting available balance:', error);
        return 0;
    }
};

/**
 * Process withdrawal approval
 * Deducts amount from wallet when withdrawal is approved
 */
const processWithdrawalApproval = async (transactionId, managerId) => {
    try {
        // Get transaction details
        const txn = await Transaction.findById(transactionId);

        if (!txn) {
            throw new Error('Transaction not found');
        }

        if (txn.status !== 'Requested' && txn.status !== 'Processing') {
            throw new Error('Transaction already processed');
        }

        // Deduct from wallet and approve transaction
        const result = await transaction(async (client) => {
            // Deduct from wallet
            await client.query(
                `UPDATE wallets 
                 SET wallet = wallet - $1, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = $2`,
                [txn.amount, txn.user_id]
            );

            // Approve transaction in withdraw_requests
            const approveResult = await client.query(
                `UPDATE withdraw_requests 
                 SET status = 1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                 RETURNING *`,
                [transactionId]
            );

            return approveResult.rows[0];
        });

        // Send email notification to blogger
        try {
            const userResult = await query('SELECT email, name FROM users WHERE id = $1', [txn.user_id]);
            if (userResult.rows.length > 0) {
                const user = userResult.rows[0];
                sendPaymentApprovedEmail(user.email, user.name, txn.amount, 'Approved by Accountant');
            }
        } catch (emailErr) {
            console.error('Accountant payment approved email failed (non-blocking):', emailErr.message);
        }

        return {
            ...result,
            status: 'Paid'
        };
    } catch (error) {
        console.error('❌ Error processing withdrawal approval:', error);
        throw error;
    }
};

module.exports = {
    addCreditToBloggerWallet,
    deductFromWallet,
    getAvailableBalance,
    getUnapprovedCreditsBalance,
    processWithdrawalApproval
};
