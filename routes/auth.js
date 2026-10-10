const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

// Stricter limit for signup endpoints (per IP)
const signupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too Many Requests', message: 'Too many attempts. Please try again later.' }
});

/**
 * @route   POST /api/auth/login
 */
router.post('/login', authController.login);

/**
 * Signup now needs email verification (two steps).
 * The old one-step /register is closed so verification can't be skipped.
 */
router.post('/register/send-code', signupLimiter, authController.sendSignupCode);
router.post('/register/verify', signupLimiter, authController.verifySignupCode);
router.post('/register', (req, res) => {
    res.status(410).json({
        error: 'Gone',
        message: 'Signup has been updated. Please refresh the page and sign up again.'
    });
});

router.post('/logout', authenticate, authController.logout);
router.get('/me', authenticate, authController.getCurrentUser);
router.put('/change-password', authenticate, authController.changePassword);
router.get('/permissions', authenticate, authController.getMyPermissions);

module.exports = router;