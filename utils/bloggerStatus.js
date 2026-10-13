/**
 * Inactive blogger helpers
 *
 * A blogger (role 'vendor') with users.status = 0 is "inactive". Nothing of theirs is
 * deleted – these SQL fragments just hide their sites / tasks / payments from listings,
 * so everything reappears as soon as the admin makes them active again.
 */

const { query } = require('../config/database');


const INACTIVE_BLOGGER_IDS = `SELECT id FROM users WHERE LOWER(role) IN ('vendor', 'blogger') AND status = 0`;
const INACTIVE_BLOGGER_EMAILS = `SELECT LOWER(TRIM(email)) FROM users WHERE LOWER(role) IN ('vendor', 'blogger') AND status = 0 AND email IS NOT NULL`;

/**
 * SQL condition: the site does NOT belong to an inactive blogger.
 * Some sites are wrongly owned by admin (id 1) and linked to the blogger only by email,
 * so those are matched by email too (same fallback the order-push code uses).
 * @param {string} alias - new_sites table alias
 */
const activeSiteSql = (alias = 'ns') => `(
    COALESCE(${alias}.uploaded_user_id, 0) NOT IN (${INACTIVE_BLOGGER_IDS})
    AND NOT (COALESCE(${alias}.uploaded_user_id, 1) = 1
             AND COALESCE(LOWER(TRIM(${alias}.email)), '') IN (${INACTIVE_BLOGGER_EMAILS}))
)`;

/**
 * SQL condition: the user id column is not an inactive blogger (NULL counts as active).
 * @param {string} column - e.g. 'nopd.vendor_id', 'wr.user_id'
 */
const activeBloggerSql = (column) => `COALESCE(${column}, 0) NOT IN (${INACTIVE_BLOGGER_IDS})`;

// Task statuses (new_order_process_details.status) that mean the work is still open:
// 5 = assigned to blogger, 6 = in progress (legacy), 7 = live link submitted / awaiting verification,
// 11 = sent back to blogger for revision
const OPEN_TASK_STATUSES = [5, 6, 7, 11];

/**
 * Reasons a blogger can't be deactivated yet (empty array = OK to deactivate).
 */
const getDeactivationBlockers = async (bloggerId) => {
    const blockers = [];

    const openTasks = await query(
        `SELECT no.order_id, ns.root_domain
         FROM new_order_process_details nopd
         JOIN new_order_processes nop ON nopd.new_order_process_id = nop.id
         JOIN new_orders no ON nop.new_order_id = no.id
         LEFT JOIN new_sites ns ON nopd.new_site_id = ns.id
         WHERE nopd.vendor_id = $1 AND nopd.status = ANY($2::int[])
         ORDER BY nopd.id DESC`,
        [bloggerId, OPEN_TASK_STATUSES]
    );
    if (openTasks.rows.length > 0) {
        const list = openTasks.rows.slice(0, 10)
            .map(t => `#${t.order_id || '-'} (${t.root_domain || 'unknown site'})`).join(', ');
        const more = openTasks.rows.length > 10 ? ` and ${openTasks.rows.length - 10} more` : '';
        blockers.push(`${openTasks.rows.length} order${openTasks.rows.length > 1 ? 's are' : ' is'} still in progress: ${list}${more}. Complete or cancel ${openTasks.rows.length > 1 ? 'them' : 'it'} first.`);
    }

    // Required here (not at the top) to avoid a circular import: walletService -> models/Transaction -> this file
    const { getUnapprovedCreditsBalance } = require('./walletService');
    const balance = await getUnapprovedCreditsBalance(bloggerId, { throwOnError: true });
    if (balance > 0) {
        blockers.push(`Wallet balance is $${balance.toFixed(2)}. The blogger must withdraw the full balance (and the payment must be approved) first.`);
    }

    return blockers;
};

/**
 * Of the given site ids, return the domains that belong to an inactive blogger
 * (used to stop new orders on hidden sites, e.g. via an old link or direct id).
 */
const findInactiveBloggerSites = async (siteIds = []) => {
    const ids = [...new Set(siteIds.map(id => parseInt(id)).filter(Boolean))];
    if (ids.length === 0) return [];
    const result = await query(
        `SELECT ns.root_domain FROM new_sites ns WHERE ns.id = ANY($1::int[]) AND NOT ${activeSiteSql('ns')}`,
        [ids]
    );
    return result.rows.map(r => r.root_domain);
};

const inactiveSitesMessage = (domains) =>
    `The blogger for ${domains.join(', ')} is inactive, so ${domains.length > 1 ? 'these sites' : 'this site'} can't be ordered right now. Please remove ${domains.length > 1 ? 'them' : 'it'} from the order.`;

// ─── Deleting a blogger ──────────────────────────────────────────────
// Only bloggers who never did any work (typically spam signups) can be deleted.
// Any order, payment or wallet history blocks it, so no old record is left pointing
// at a blogger that no longer exists.

/**
 * SQL expression (boolean): the blogger with id column `idCol` can be deleted.
 * Used to show the delete icon only on rows where deleting is possible.
 */
const canDeleteBloggerSql = (idCol = 'u.id') => `(
    NOT EXISTS (SELECT 1 FROM new_order_process_details d WHERE d.vendor_id = ${idCol})
    AND NOT EXISTS (SELECT 1 FROM withdraw_requests wr WHERE wr.user_id = ${idCol})
    AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = ${idCol} AND COALESCE(w.balance, 0) <> 0)
    AND NOT EXISTS (SELECT 1 FROM order_histories oh WHERE oh.user_id = ${idCol})
    AND NOT EXISTS (SELECT 1 FROM new_sites s JOIN new_order_process_details d ON d.new_site_id = s.id WHERE s.uploaded_user_id = ${idCol})
    AND NOT EXISTS (SELECT 1 FROM new_sites s JOIN client_order_details c ON c.site_id = s.id WHERE s.uploaded_user_id = ${idCol})
)`;

/**
 * Reasons a blogger can't be deleted (empty array = OK to delete).
 */
const getDeletionBlockers = async (bloggerId) => {
    const blockers = [];

    const tasks = await query(
        `SELECT
            COUNT(*) FILTER (WHERE status = ANY($2::int[])) AS in_progress,
            COUNT(*) FILTER (WHERE status = 8) AS completed,
            COUNT(*) AS total
         FROM new_order_process_details WHERE vendor_id = $1`,
        [bloggerId, OPEN_TASK_STATUSES]
    );
    const t = tasks.rows[0];
    const inProgress = parseInt(t.in_progress), completed = parseInt(t.completed), total = parseInt(t.total);
    if (inProgress > 0) blockers.push(`${inProgress} order${inProgress > 1 ? 's are' : ' is'} still in progress.`);
    if (completed > 0) blockers.push(`This blogger has already completed ${completed} order${completed > 1 ? 's' : ''}.`);
    const otherTasks = total - inProgress - completed;
    if (otherTasks > 0) blockers.push(`This blogger has ${otherTasks} past order${otherTasks > 1 ? 's' : ''} (declined/rejected) in their history.`);

    const { getUnapprovedCreditsBalance } = require('./walletService');
    const balance = await getUnapprovedCreditsBalance(bloggerId, { throwOnError: true });
    const wallet = await query(`SELECT COALESCE(SUM(balance), 0) AS balance FROM wallets WHERE user_id = $1`, [bloggerId]);
    const walletBalance = Math.max(balance, parseFloat(wallet.rows[0].balance) || 0);
    if (walletBalance > 0) blockers.push(`Wallet balance is $${walletBalance.toFixed(2)}.`);

    const payments = await query(`SELECT COUNT(*) AS c FROM withdraw_requests WHERE user_id = $1`, [bloggerId]);
    if (parseInt(payments.rows[0].c) > 0) blockers.push(`This blogger has payment/withdrawal history.`);

    const history = await query(`SELECT COUNT(*) AS c FROM order_histories WHERE user_id = $1`, [bloggerId]);
    if (parseInt(history.rows[0].c) > 0) blockers.push(`This blogger has order history records.`);

    const usedSites = await query(
        `SELECT DISTINCT s.root_domain FROM new_sites s
         WHERE s.uploaded_user_id = $1
           AND (EXISTS (SELECT 1 FROM new_order_process_details d WHERE d.new_site_id = s.id)
                OR EXISTS (SELECT 1 FROM client_order_details c WHERE c.site_id = s.id))
         LIMIT 10`,
        [bloggerId]
    );
    if (usedSites.rows.length > 0) {
        blockers.push(`Their site${usedSites.rows.length > 1 ? 's' : ''} ${usedSites.rows.map(r => r.root_domain).join(', ')} ${usedSites.rows.length > 1 ? 'are' : 'is'} part of existing orders.`);
    }

    return blockers;
};

/**
 * Permanently delete a blogger and everything that belongs only to them.
 * Runs in one transaction: if any step fails, nothing is deleted.
 * Call getDeletionBlockers first.
 */
const deleteBloggerData = async (bloggerId) => {
    const { transaction } = require('../config/database');
    return transaction(async (client) => {
        const exists = async (table) => (await client.query('SELECT to_regclass($1) AS t', [`public.${table}`])).rows[0].t !== null;
        const removed = {};
        const del = async (label, sql) => {
            const r = await client.query(sql, [bloggerId]);
            removed[label] = (removed[label] || 0) + r.rowCount;
        };

        await del('sites', `DELETE FROM new_sites WHERE uploaded_user_id = $1`);
        if (await exists('bulk_upload_sites')) await del('bulk_upload_sites', `DELETE FROM bulk_upload_sites WHERE uploaded_user_id = $1`);
        if (await exists('bulk_uploads')) await del('bulk_uploads', `DELETE FROM bulk_uploads WHERE vendor_id = $1`);
        if (await exists('bulk_upload_requests')) await del('bulk_upload_requests', `DELETE FROM bulk_upload_requests WHERE user_id = $1`);
        if (await exists('delete_sites')) await del('delete_sites', `DELETE FROM delete_sites WHERE uploaded_user_id = $1`);
        await del('wallets', `DELETE FROM wallets WHERE user_id = $1`);
        await del('notifications', `DELETE FROM notifications WHERE notifiable_id = $1 AND notifiable_type = 'App\\Models\\User'`);
        if (await exists('assign_permissions')) await del('permissions', `DELETE FROM assign_permissions WHERE user_id = $1`);
        if (await exists('email_queue_lists')) await del('email_queue', `DELETE FROM email_queue_lists WHERE user_id = $1`);
        if (await exists('personal_access_tokens')) await del('tokens', `DELETE FROM personal_access_tokens WHERE tokenable_id = $1 AND tokenable_type = 'App\\Models\\User'`);

        // Chats the blogger took part in (and all their messages). Only use the
        // participant columns that actually exist in this database.
        if (await exists('threads') && await exists('thread_messages')) {
            const cols = (await client.query(
                `SELECT column_name FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'threads'
                   AND column_name IN ('owner_id', 'user_id', 'created_by', 'assigned_to')`
            )).rows.map(r => r.column_name);
            if (cols.length > 0) {
                const chatFilter = cols.map(c => `${c} = $1`).join(' OR ');
                await del('chat_messages', `DELETE FROM thread_messages WHERE user_id = $1 OR thread_id IN (SELECT id FROM threads WHERE ${chatFilter})`);
                await del('chats', `DELETE FROM threads WHERE ${chatFilter}`);
            }
        }

        await del('user', `DELETE FROM users WHERE id = $1 AND LOWER(role) IN ('vendor', 'blogger')`);
        if (removed.user !== 1) throw new Error('Blogger could not be deleted');
        return removed;
    });
};

module.exports = {
    canDeleteBloggerSql,
    getDeletionBlockers,
    deleteBloggerData,
    activeSiteSql,
    activeBloggerSql,
    getDeactivationBlockers,
    findInactiveBloggerSites,
    inactiveSitesMessage,
    OPEN_TASK_STATUSES
};
