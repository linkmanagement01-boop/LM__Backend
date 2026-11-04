/**
 * Marketplace-style filters for the team's Sites pages (admin + manager):
 * FC prices toggle, order type (GP / NE), min–max ranges, category picked from the list, and sort.
 * Blogger prices are text ("$15", "N/A"), so they are read as numbers here (NULL = no price).
 */
const { query } = require('../config/database');

const priceNum = (col) => {
    const cleaned = `REGEXP_REPLACE(COALESCE(${col}::text, ''), '[^0-9.]', '', 'g')`;
    return `(CASE WHEN ${cleaned} ~ '^[0-9]+(\\.[0-9]+)?$' AND ${cleaned}::numeric > 0 THEN ${cleaned}::numeric END)`;
};
const trafficSql = `(CASE WHEN ns.traffic_source::text ~ '^[0-9]+(\\.[0-9]+)?$' THEN ns.traffic_source::numeric ELSE 0 END)`;
// The category shown (category, else niche); spellings that differ only in capitals count as one
const categorySql = `COALESCE(NULLIF(TRIM(ns.category), ''), NULLIF(TRIM(ns.niche), ''))`;
const categoryKeySql = `LOWER(${categorySql})`;

const isFc = (q) => q.fc === '1' || q.fc === 'true';
/** GP / NE price expressions – FC prices (fc_gp / fc_ne) when FC is on */
const prices = (fc) => ({ gp: priceNum(fc ? 'ns.fc_gp' : 'ns.gp_price'), ne: priceNum(fc ? 'ns.fc_ne' : 'ns.niche_edit_price') });

/**
 * Add the filters from the query string to conditions / params (placeholders follow params.length).
 * Returns the ORDER BY for the chosen sort.
 */
const applySiteFilters = (q, conditions, params) => {
    const add = (cond, value) => { params.push(value); conditions.push(cond(`$${params.length}`)); };
    const fc = isFc(q);
    const { gp, ne } = prices(fc);

    // FC on → only sites that take FC content (have an FC price)
    if (fc) conditions.push(`(${gp} IS NOT NULL OR ${ne} IS NOT NULL)`);
    if (q.type === 'gp') conditions.push(`${gp} IS NOT NULL`);
    if (q.type === 'ne') conditions.push(`${ne} IS NOT NULL`);
    if (q.category) add(p => `${categoryKeySql} = LOWER(TRIM(${p}))`, String(q.category));

    const range = (col, min, max) => {
        if (min !== undefined && min !== '' && !isNaN(Number(min))) add(p => `${col} >= ${p}`, Number(min));
        if (max !== undefined && max !== '' && !isNaN(Number(max))) add(p => `${col} <= ${p}`, Number(max));
    };
    const priceCol = q.type === 'ne' ? ne : q.type === 'gp' ? gp : `NULLIF(LEAST(COALESCE(${gp}, 1e12), COALESCE(${ne}, 1e12)), 1e12)`;
    range(priceCol, q.min_price, q.max_price);
    range('ns.dr', q.min_dr, q.max_dr);
    range('ns.da', q.min_da, q.max_da);
    range(trafficSql, q.min_traffic, q.max_traffic);

    const sorts = {
        newest: 'ns.created_at DESC NULLS LAST',
        price_asc: `${priceCol} ASC NULLS LAST`,
        price_desc: `${priceCol} DESC NULLS LAST`,
        dr_desc: 'ns.dr DESC NULLS LAST',
        da_desc: 'ns.da DESC NULLS LAST',
        traffic_desc: `${trafficSql} DESC`
    };
    return `${sorts[q.sort] || sorts.newest}, ns.id DESC`;
};

/** Categories of the sites in the list (FC sites only when FC is on), with counts */
const siteCategories = async (q, conditions, params = []) => {
    const where = [...conditions, `${categorySql} IS NOT NULL`];
    if (isFc(q)) { const { gp, ne } = prices(true); where.push(`(${gp} IS NOT NULL OR ${ne} IS NOT NULL)`); }
    return (await query(
        `SELECT (ARRAY_AGG(name ORDER BY c DESC, name))[1] AS name, SUM(c)::int AS count
         FROM (SELECT ${categorySql} AS name, ${categoryKeySql} AS key, COUNT(*) AS c
               FROM new_sites ns WHERE ${where.join(' AND ')} GROUP BY 1, 2) t
         GROUP BY key
         ORDER BY count DESC, name`,
        params
    )).rows;
};

/** Site status filter value (Approved / Pending / Rejected) → site_status code */
const statusCode = (v) => (v === 'Approved' ? '1' : v === 'Rejected' ? '2' : '0');

module.exports = { applySiteFilters, siteCategories, statusCode };
