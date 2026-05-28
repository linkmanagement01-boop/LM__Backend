const { query } = require('../config/database');
const logger = require('../utils/logger');

/**
 * Admin Report Controller
 * Handles financial reporting for client revenue and blogger payments
 */
const getFinancialReport = async (req, res, next) => {
    try {
        const { startDate, endDate, clientId, bloggerId, contentType, website } = req.query;

        // 1. Build dynamic WHERE clauses for the query
        let whereClause = 'WHERE 1=1';
        const params = [];
        let pIdx = 1;

        if (startDate) {
            whereClause += ` AND co.created_at::date >= $${pIdx}`;
            params.push(startDate);
            pIdx++;
        }
        if (endDate) {
            whereClause += ` AND co.created_at::date <= $${pIdx}`;
            params.push(endDate);
            pIdx++;
        }
        if (clientId) {
            whereClause += ` AND co.client_user_id = $${pIdx}`;
            params.push(parseInt(clientId, 10));
            pIdx++;
        }
        if (bloggerId) {
            whereClause += ` AND nopd.vendor_id = $${pIdx}`;
            params.push(parseInt(bloggerId, 10));
            pIdx++;
        }
        if (contentType) {
            whereClause += ` AND co.order_type = $${pIdx}`;
            params.push(contentType);
            pIdx++;
        }
        if (website) {
            whereClause += ` AND ns.root_domain ILIKE $${pIdx}`;
            params.push(`%${website}%`);
            pIdx++;
        }

        // 2. Fetch financial records
        const sql = `
            SELECT 
                co.created_at as date,
                co.id as order_id,
                c.id as client_id,
                c.name as client_name,
                c.email as client_email,
                ns.root_domain as website,
                co.order_type as content_type,
                COALESCE(cod.price, 0) as client_charged,
                'USD' as currency,
                co.status as payment_status,
                b.id as blogger_id,
                b.name as blogger_name,
                b.email as blogger_email,
                -- Blogger paid = ONLY actual wallet credits (real payments made)
                -- Do NOT fall back to nopd.price or site base prices as those are estimates, not actual payments
                COALESCE(
                    (SELECT wh.price FROM wallet_histories wh WHERE wh.order_detail_id = nopd.id AND LOWER(wh.type) = 'credit' LIMIT 1),
                    0
                ) as blogger_paid,
                nopd.status as blogger_status,
                nopd.price as estimated_blogger_cost
            FROM client_order_details cod
            JOIN client_orders co ON cod.client_order_id = co.id
            JOIN users c ON co.client_user_id = c.id
            LEFT JOIN new_sites ns ON cod.site_id = ns.id
            LEFT JOIN new_orders no ON co.linked_new_order_id = no.id
            LEFT JOIN new_order_processes nop ON nop.new_order_id = no.id AND nop.id = (
                SELECT id FROM new_order_processes WHERE new_order_id = no.id ORDER BY id DESC LIMIT 1
            )
            LEFT JOIN new_order_process_details nopd ON nopd.new_order_process_id = nop.id AND nopd.new_site_id = ns.id
            LEFT JOIN users b ON nopd.vendor_id = b.id
            ${whereClause}
            ORDER BY co.created_at DESC
        `;

        const result = await query(sql, params);
        const records = result.rows.map(row => {
            const clientCharged = parseFloat(row.client_charged) || 0;
            const bloggerPaid = parseFloat(row.blogger_paid) || 0;
            const profit = clientCharged - bloggerPaid;
            const margin = clientCharged > 0 ? (profit / clientCharged) * 100 : 0;

            return {
                ...row,
                client_charged: clientCharged,
                blogger_paid: bloggerPaid,
                estimated_blogger_cost: parseFloat(row.estimated_blogger_cost) || 0,
                profit,
                margin
            };
        });

        // 3. Calculate summary metrics
        let totalRevenue = 0;
        let totalBloggerCost = 0;

        records.forEach(r => {
            totalRevenue += r.client_charged;
            totalBloggerCost += r.blogger_paid;
        });

        const totalProfit = totalRevenue - totalBloggerCost;
        const averageMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

        // 4. Fetch list of clients and bloggers for filter dropdowns
        const clientsRes = await query(`
            SELECT DISTINCT c.id, c.name, c.email 
            FROM client_orders co 
            JOIN users c ON co.client_user_id = c.id
            ORDER BY c.name
        `);
        // Only fetch bloggers who are linked to client orders (not ALL bloggers)
        const bloggersRes = await query(`
            SELECT DISTINCT b.id, b.name, b.email 
            FROM client_orders co
            JOIN new_orders no ON co.linked_new_order_id = no.id
            JOIN new_order_processes nop ON nop.new_order_id = no.id
            JOIN new_order_process_details nopd ON nopd.new_order_process_id = nop.id
            JOIN users b ON nopd.vendor_id = b.id
            ORDER BY b.name
        `);

        res.json({
            records,
            summary: {
                totalRevenue,
                totalBloggerCost,
                totalProfit,
                averageMargin
            },
            filters: {
                clients: clientsRes.rows,
                bloggers: bloggersRes.rows
            }
        });
    } catch (error) {
        logger.error('Admin:GetFinancialReport', error);
        next(error);
    }
};

module.exports = {
    getFinancialReport
};
