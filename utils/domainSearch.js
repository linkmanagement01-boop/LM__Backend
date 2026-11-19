/**
 * Domain search for the Sites lists (admin Sites, admin Deleted Sites, manager View All Sites).
 *
 *   "om"           → sites whose NAME starts with "om" (omsites.net); only if there are none, names containing "om"
 *                    (romantic-blog.org). The ending is ignored – "om" no longer matches every ".com".
 *   "kazgadgets.c" → typed with a dot: searched in the full domain (so exact lookups keep working)
 * The name is the domain without http(s)://, www. and everything from the first dot on.
 */
const { query } = require('../config/database');

const cleanSql = (col) => `REGEXP_REPLACE(REGEXP_REPLACE(LOWER(TRIM(${col})), '^https?://', ''), '^www\\.', '')`;
const nameSql = (col) => `REGEXP_REPLACE(${cleanSql(col)}, '[./].*$', '')`;
const like = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`); // typed % or _ are plain characters

/**
 * Adds the domain condition to `conditions` / `params` (call it after every other filter is in, right before the
 * WHERE clause is built). `from` must be the same FROM … as the list query so "starts with" respects the other filters.
 */
const applyDomainSearch = async (raw, conditions, params, { from = 'FROM new_sites ns', col = 'ns.root_domain' } = {}) => {
    const term = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
    if (!term) return null;
    if (term.includes('.')) {
        params.push(`%${like(term)}%`);
        conditions.push(`${cleanSql(col)} LIKE $${params.length}`);
        return 'full';
    }
    params.push(`${like(term)}%`);
    const idx = params.length;
    const starts = `${nameSql(col)} LIKE $${idx}`;
    const found = (await query(`SELECT 1 ${from} WHERE ${[...conditions, starts].join(' AND ')} LIMIT 1`, params)).rows.length;
    if (!found) params[idx - 1] = `%${like(term)}%`; // nothing starts with it → names that contain it
    conditions.push(starts);
    return found ? 'starts' : 'contains';
};

module.exports = { applyDomainSearch };
