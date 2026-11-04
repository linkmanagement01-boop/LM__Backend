const express = require('express');
const router = express.Router();
const faqs = require('../utils/faqs');

/**
 * Public routes (no login) – content for the website's public pages
 */

/**
 * @route   GET /api/public/faqs
 * @desc    Active FAQs for the FAQ page, in tab (category) and display order
 * @access  Public
 */
router.get('/faqs', async (req, res, next) => {
    try {
        res.set('Cache-Control', 'public, max-age=60');
        res.json({ categories: faqs.CATEGORIES, faqs: await faqs.listActive() });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
