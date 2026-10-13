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

module.exports = {
    activeSiteSql,
    activeBloggerSql,
    getDeactivationBlockers,
    findInactiveBloggerSites,
    inactiveSitesMessage,
    OPEN_TASK_STATUSES
};
