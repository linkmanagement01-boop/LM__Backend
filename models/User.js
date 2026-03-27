const { query } = require('../config/database');
const bcrypt = require('bcryptjs');

/**
 * User Model - Production Database Compatible
 * Handles all database operations related to users
 * 
 * Production schema uses:
 * - `name` instead of `username`
 * - `password` instead of `password_hash`
 * - `status` (integer: 1=active) instead of `is_active` (boolean)
 * - `wallets` table for balance instead of `wallet_balance` column
 * - Role mapping: 'vendor' in DB = 'Blogger' in app
 */

// Role mapping between app and database
const ROLE_MAP = {
    'Admin': 'admin',
    'Manager': 'manager',
    'Team': 'team',
    'Writer': 'writer',
    'Blogger': 'vendor',  // Production uses 'vendor' for bloggers
    'Accountant': 'accountant',
    'SuperAdmin': 'super_admin'
};

const ROLE_MAP_REVERSE = {
    'admin': 'Admin',
    'manager': 'Manager',
    'team': 'Team',
    'writer': 'Writer',
    'vendor': 'Blogger',
    'accountant': 'Accountant',
    'super_admin': 'SuperAdmin'
};

class User {
    /**
     * Map database role to app role
     */
    static mapRole(dbRole) {
        return ROLE_MAP_REVERSE[dbRole] || dbRole;
    }

    /**
     * Map app role to database role
     */
    static mapRoleToDb(appRole) {
        return ROLE_MAP[appRole] || appRole.toLowerCase();
    }

    /**
     * Find user by email
     */
    static async findByEmail(email) {
        const result = await query(
            `SELECT u.*, w.balance as wallet_balance 
             FROM users u 
             LEFT JOIN wallets w ON w.user_id = u.id 
             WHERE u.email = $1`,
            [email]
        );
        if (result.rows[0]) {
            const user = result.rows[0];
            // Add compatibility aliases
            user.username = user.name;
            user.password_hash = user.password;
            user.is_active = user.status === 1;
            user.role = this.mapRole(user.role);
        }
        return result.rows[0];
    }

    /**
     * Find user by ID
     */
    static async findById(id) {
        const result = await query(
            `SELECT u.id, u.name, u.email, u.role, u.status, u.created_at, 
                    COALESCE(w.balance, 0) as wallet_balance
             FROM users u 
             LEFT JOIN wallets w ON w.user_id = u.id 
             WHERE u.id = $1`,
            [id]
        );
        if (result.rows[0]) {
            const user = result.rows[0];
            // Add compatibility aliases
            user.username = user.name;
            user.is_active = user.status === 1;
            user.role = this.mapRole(user.role);
        }
        return result.rows[0];
    }

    /**
     * Get all users (Admin only)
     */
    static async findAll(filters = {}) {
        let sql = `SELECT u.id, u.name, u.email, u.role, u.status, u.created_at,
                          COALESCE(w.balance, 0) as wallet_balance
                   FROM users u 
                   LEFT JOIN wallets w ON w.user_id = u.id 
                   WHERE 1=1`;
        const params = [];
        let paramIndex = 1;

        if (filters.role) {
            const dbRole = this.mapRoleToDb(filters.role);
            sql += ` AND u.role = $${paramIndex}`;
            params.push(dbRole);
            paramIndex++;
        }

        if (filters.is_active !== undefined) {
            sql += ` AND u.status = $${paramIndex}`;
            params.push(filters.is_active ? 1 : 0);
            paramIndex++;
        }

        sql += ' ORDER BY u.created_at DESC';

        const result = await query(sql, params);
        return result.rows.map(user => ({
            ...user,
            username: user.name,
            is_active: user.status === 1,
            role: this.mapRole(user.role)
        }));
    }

    /**
     * Create new user
     */
    static async create(userData) {
        const { username, name, email, password, role } = userData;
        const userName = name || username;
        const dbRole = this.mapRoleToDb(role);

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        const result = await query(
            `INSERT INTO users (name, email, password, role, status) 
             VALUES ($1, $2, $3, $4, 1) 
             RETURNING id, name, email, role, created_at`,
            [userName, email, hashedPassword, dbRole]
        );

        // Create wallet for user
        await query(
            'INSERT INTO wallets (user_id, balance) VALUES ($1, 0)',
            [result.rows[0].id]
        );

        const user = result.rows[0];
        user.username = user.name;
        user.wallet_balance = 0;
        user.role = this.mapRole(user.role);
        return user;
    }

    /**
     * Update user
     */
    static async update(id, updates) {
        // Map field names to production schema
        const fieldMapping = {
            'username': 'name',
            'name': 'name',
            'email': 'email',
            'role': 'role',
            'is_active': 'status'
        };

        const setClause = [];
        const params = [];
        let paramIndex = 1;

        for (const [key, value] of Object.entries(updates)) {
            const dbField = fieldMapping[key];
            if (dbField) {
                let dbValue = value;
                if (key === 'role') {
                    dbValue = this.mapRoleToDb(value);
                } else if (key === 'is_active') {
                    dbValue = value ? 1 : 0;
                }
                setClause.push(`${dbField} = $${paramIndex}`);
                params.push(dbValue);
                paramIndex++;
            }
        }

        if (setClause.length === 0) {
            throw new Error('No valid fields to update');
        }

        params.push(id);

        const result = await query(
            `UPDATE users SET ${setClause.join(', ')}, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $${paramIndex} 
             RETURNING id, name, email, role, status`,
            params
        );

        if (result.rows[0]) {
            const user = result.rows[0];
            user.username = user.name;
            user.is_active = user.status === 1;
            user.role = this.mapRole(user.role);
        }
        return result.rows[0];
    }

    /**
     * Delete user
     */
    static async delete(id) {
        const result = await query(
            'DELETE FROM users WHERE id = $1 RETURNING id',
            [id]
        );
        return result.rows[0];
    }

    /**
     * Verify password
     */
    static async verifyPassword(plainPassword, hashedPassword) {
        return await bcrypt.compare(plainPassword, hashedPassword);
    }

    /**
     * Update wallet balance (for vendors/bloggers)
     */
    static async updateWalletBalance(userId, amount) {
        // Check if wallet exists
        const wallet = await query(
            'SELECT id, balance FROM wallets WHERE user_id = $1',
            [userId]
        );

        if (wallet.rows.length === 0) {
            // Create wallet if doesn't exist
            await query(
                'INSERT INTO wallets (user_id, balance) VALUES ($1, $2)',
                [userId, amount]
            );
            return { id: userId, wallet_balance: amount };
        }

        const result = await query(
            `UPDATE wallets 
             SET balance = balance + $1 
             WHERE user_id = $2 
             RETURNING user_id as id, balance as wallet_balance`,
            [amount, userId]
        );
        return result.rows[0];
    }

    /**
     * Get wallet balance
     */
    static async getWalletBalance(userId) {
        const result = await query(
            'SELECT balance FROM wallets WHERE user_id = $1',
            [userId]
        );
        return result.rows[0]?.balance || 0;
    }

    /**
     * Get users by role (for dropdowns)
     */
    static async getByRole(role) {
        const dbRole = this.mapRoleToDb(role);
        const result = await query(
            `SELECT id, name, email FROM users WHERE role = $1 AND status = 1 ORDER BY name`,
            [dbRole]
        );
        return result.rows.map(user => ({
            ...user,
            username: user.name
        }));
    }
}

module.exports = User;
