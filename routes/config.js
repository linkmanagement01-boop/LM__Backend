const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

/**
 * System Config Routes
 * Manage system-wide configuration
 * All routes require Admin authentication
 */

// Protect all config routes - require authentication + admin role
router.use(authenticate, authorize('super_admin', 'admin'));

/**
 * @route   GET /api/config
 * @desc    Get all configuration settings
 * @access  Admin only
 */
router.get('/', async (req, res, next) => {
    try {
        const result = await query('SELECT * FROM system_config ORDER BY config_key');

        // Convert to key-value object
        const config = {};
        result.rows.forEach(row => {
            config[row.config_key] = {
                value: row.config_value,
                description: row.description,
                updated_at: row.updated_at
            };
        });

        res.json({ config });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   PUT /api/config/:key
 * @desc    Update configuration setting
 * @access  Admin only
 */
router.put('/:key', async (req, res, next) => {
    try {
        const { key } = req.params;
        const { value, description } = req.body;

        if (!value) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Value is required'
            });
        }

        const result = await query(
            `INSERT INTO system_config (config_key, config_value, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (config_key) 
       DO UPDATE SET config_value = $2, description = COALESCE($3, system_config.description)
       RETURNING *`,
            [key, value, description]
        );

        res.json({
            message: 'Configuration updated successfully',
            config: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
});

/**
 * @route   GET /api/config/:key
 * @desc    Get specific configuration value
 * @access  Public (for allowed keys)
 */
router.get('/:key', async (req, res, next) => {
    try {
        const { key } = req.params;

        const result = await query(
            'SELECT * FROM system_config WHERE config_key = $1',
            [key]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'Configuration key not found'
            });
        }

        res.json({
            config: result.rows[0]
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
