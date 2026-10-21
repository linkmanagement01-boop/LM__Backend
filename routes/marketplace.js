/**
 * Marketplace storefront API – /api/marketplace/:marketplace/...   (e.g. /api/marketplace/whitelabel/sites)
 * Separate from the internal client area (/api/client). Clients here only see marketplace prices.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const m = require('../controllers/marketplaceController');

const router = express.Router({ mergeParams: true });

// Guest Post content files from clients (same folder as writer content files)
const contentDir = path.join(__dirname, '../uploads/content-files');
fs.mkdirSync(contentDir, { recursive: true });
const CONTENT_TYPES = ['.pdf', '.doc', '.docx'];
const contentUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, contentDir),
        filename: (req, file, cb) => cb(null, `mp-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
    }),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (CONTENT_TYPES.includes(path.extname(file.originalname).toLowerCase())) return cb(null, true);
        const e = new Error('Only PDF, DOC or DOCX files can be uploaded');
        e.statusCode = 400;
        cb(e);
    }
});
const uploadOne = (req, res, next) => contentUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 25 MB)' : err.message;
    res.status(400).json({ error: 'Validation Error', message });
});

// Signup/login are limited per IP to slow down abuse
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too Many Requests', message: 'Too many attempts – please try again in a few minutes' } });

router.use('/:marketplace', m.checkMarketplace);

// Public
router.post('/:marketplace/auth/send-code', authLimiter, m.sendSignupCode);
router.post('/:marketplace/auth/verify', authLimiter, m.verifySignupCode);
router.post('/:marketplace/auth/login', authLimiter, m.login);

// Logged-in marketplace clients
router.get('/:marketplace/me', m.requireClient, m.me);
router.get('/:marketplace/sites', m.requireClient, m.getSites);
router.get('/:marketplace/sites/:id/posts', m.requireClient, m.getSitePosts);
router.post('/:marketplace/uploads/content', m.requireClient, uploadOne, m.uploadContent);

router.get('/:marketplace/cart', m.requireClient, m.getCart);
router.post('/:marketplace/cart', m.requireClient, m.addToCart);
router.put('/:marketplace/cart/:id', m.requireClient, m.updateCartItem);
router.delete('/:marketplace/cart/:id', m.requireClient, m.removeCartItem);
router.post('/:marketplace/checkout', m.requireClient, m.checkout);

router.get('/:marketplace/orders', m.requireClient, m.getOrders);
router.get('/:marketplace/orders/:id', m.requireClient, m.getOrder);

router.get('/:marketplace/wallet', m.requireClient, m.getWallet);
router.post('/:marketplace/wallet/paypal/create', m.requireClient, m.createPaypalTopup);
router.post('/:marketplace/wallet/paypal/capture', m.requireClient, m.capturePaypalTopup);

router.get('/:marketplace/dashboard', m.requireClient, m.getDashboard);
router.get('/:marketplace/transactions', m.requireClient, m.getTransactions);
router.get('/:marketplace/profile', m.requireClient, m.getProfile);
router.put('/:marketplace/profile', m.requireClient, m.updateProfile);
router.put('/:marketplace/profile/password', authLimiter, m.requireClient, m.changePassword);

router.get('/:marketplace/notifications', m.requireClient, m.getNotifications);
router.post('/:marketplace/notifications/read', m.requireClient, m.markNotificationsRead);

module.exports = router;
