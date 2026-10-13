const { query } = require('../config/database');
const { activeSiteSql } = require('../utils/bloggerStatus');

/**
 * Website Model - Production Database Compatible
 * Handles website/site inventory management
 * 
 * Production schema mapping:
 * - websites → new_sites table
 * - domain_url → root_domain
 * - da_pa_score → da (double precision)
 * - blogger_id → uploaded_user_id (owner/vendor)
 */
class Website {
    /**
     * Get all websites/sites with full details
     */
    static async findAll(filters = {}) {
        let sql = `
            SELECT 
                ns.id,
                ns.root_domain as domain_url,
                ns.niche as category,
                ns.da,
                ns.dr,
                ns.traffic,
                ns.rd,
                ns.gp_price,
                ns.niche_edit_price as niche_price,
                ns.site_status as status,
                ns.uploaded_user_id as blogger_id,
                ns.created_at,
                ns.updated_at,
                u.name as blogger_name
            FROM new_sites ns
            LEFT JOIN users u ON ns.uploaded_user_id = u.id
            WHERE ${activeSiteSql('ns')}
        `;
        const params = [];
        let paramIndex = 1;

        if (filters.status) {
            sql += ` AND ns.site_status = $${paramIndex}`;
            params.push(filters.status);
            paramIndex++;
        }

        if (filters.category) {
            sql += ` AND ns.niche = $${paramIndex}`;
            params.push(filters.category);
            paramIndex++;
        }

        if (filters.blogger_id) {
            sql += ` AND ns.uploaded_user_id = $${paramIndex}`;
            params.push(filters.blogger_id);
            paramIndex++;
        }

        sql += ' ORDER BY ns.created_at DESC LIMIT 100';

        const result = await query(sql, params);
        return result.rows.map(row => ({
            ...row,
            da_pa_score: row.da
        }));
    }

    /**
     * Find website by ID
     */
    static async findById(id) {
        const result = await query(
            `SELECT 
                ns.id,
                ns.root_domain as domain_url,
                ns.niche as category,
                ns.da,
                ns.dr,
                ns.traffic,
                ns.rd,
                ns.gp_price,
                ns.niche_edit_price as niche_price,
                ns.site_status as status,
                ns.uploaded_user_id as blogger_id,
                ns.sample_url,
                ns.email,
                ns.created_at,
                ns.updated_at,
                u.name as blogger_name
             FROM new_sites ns
             LEFT JOIN users u ON ns.uploaded_user_id = u.id
             WHERE ns.id = $1`,
            [id]
        );

        if (result.rows[0]) {
            result.rows[0].da_pa_score = result.rows[0].da;
        }
        return result.rows[0];
    }

    /**
     * Create new website/site
     */
    static async create(websiteData) {
        const {
            domain_url, root_domain, category, niche, da_pa_score, da, dr, traffic, rd,
            niche_price, gp_price, status, added_by, blogger_id
        } = websiteData;

        const result = await query(
            `INSERT INTO new_sites (
                root_domain, niche, da, dr, traffic, rd, 
                niche_edit_price, gp_price, site_status, uploaded_user_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
            RETURNING *`,
            [
                root_domain || domain_url,
                niche || category,
                da || da_pa_score || 0,
                dr || 0,
                traffic || 0,
                rd || 0,
                niche_price || 0,
                gp_price || 0,
                status || 'Active',
                blogger_id || added_by
            ]
        );

        const site = result.rows[0];
        return {
            ...site,
            domain_url: site.root_domain,
            category: site.niche,
            da_pa_score: site.da,
            niche_price: site.niche_edit_price
        };
    }

    /**
     * Bulk create websites
     */
    static async bulkCreate(websites, added_by) {
        const insertPromises = websites.map(website =>
            this.create({ ...website, added_by })
        );

        return await Promise.all(insertPromises);
    }

    /**
     * Update website
     */
    static async update(id, updates) {
        // Map field names from frontend to database columns
        const fieldMapping = {
            'domain_url': 'root_domain',
            'root_domain': 'root_domain',
            'category': 'niche',
            'niche': 'niche',
            'website_niche': 'website_niche',
            'traffic_source': 'country_source',
            'country_source': 'country_source',
            'spam_score': 'spam_score',
            'sample_url': 'sample_url',
            'website_status': 'website_status',
            'href_url': 'href_url',
            'marked_sponsor': 'marked_sponsor',
            'grey_niche_types': 'grey_niche_types',
            'da_pa_score': 'da',
            'da': 'da',
            'dr': 'dr',
            'traffic': 'traffic',
            'rd': 'rd',
            'niche_price': 'niche_edit_price',
            'niche_edit_price': 'niche_edit_price',
            'gp_price': 'gp_price',
            'deal_cbd_casino': 'deal_cbd_casino',
            'fc_gp': 'fc_gp',
            'fc_ne': 'fc_ne',
            'paypal_id': 'paypal_id',
            'whatsapp': 'whatsapp',
            'skype': 'skype',
            'status': 'site_status',
            'site_status': 'site_status',
            'blogger_id': 'uploaded_user_id'
        };

        // Fields that are double precision in PostgreSQL - empty strings must become null
        const numericFields = new Set([
            'da', 'dr', 'traffic', 'rd', 'fc_gp', 'fc_ne', 'total_time'
        ]);

        const setClause = [];
        const params = [];
        let paramIndex = 1;

        for (const [key, value] of Object.entries(updates)) {
            const dbField = fieldMapping[key];
            if (dbField) {
                // Convert empty strings to null for numeric columns
                let sanitized = value;
                if (numericFields.has(dbField) && (value === '' || value === null || value === undefined)) {
                    sanitized = null;
                }
                setClause.push(`${dbField} = $${paramIndex}`);
                params.push(sanitized);
                paramIndex++;
            }
        }

        if (setClause.length === 0) {
            throw new Error('No valid fields to update');
        }

        params.push(id);

        const result = await query(
            `UPDATE new_sites SET ${setClause.join(', ')}, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $${paramIndex} 
             RETURNING *`,
            params
        );

        const site = result.rows[0];
        if (site) {
            return {
                ...site,
                domain_url: site.root_domain,
                category: site.niche,
                da_pa_score: site.da,
                niche_price: site.niche_edit_price
            };
        }
        return site;
    }

    /**
     * Delete website
     */
    static async delete(id) {
        const result = await query(
            'DELETE FROM new_sites WHERE id = $1 RETURNING id',
            [id]
        );
        return result.rows[0];
    }

    /**
     * Get active websites count
     */
    static async getActiveCount() {
        const result = await query(
            "SELECT COUNT(*) as count FROM new_sites WHERE site_status = 'Active'"
        );
        return parseInt(result.rows[0].count);
    }

    /**
     * Search websites by domain
     */
    static async search(searchTerm, limit = 20) {
        const result = await query(
            `SELECT 
                id, root_domain as domain_url, niche as category,
                da, dr, traffic, gp_price, niche_edit_price as niche_price
             FROM new_sites 
             WHERE root_domain ILIKE $1 
             ORDER BY da DESC 
             LIMIT $2`,
            [`%${searchTerm}%`, limit]
        );
        return result.rows.map(row => ({
            ...row,
            da_pa_score: row.da
        }));
    }
}

module.exports = Website;
