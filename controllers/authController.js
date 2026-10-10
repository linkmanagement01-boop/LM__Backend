const User = require('../models/User');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sendVerificationCodeEmail } = require('../utils/emailService');
const { validateSignupEmail } = require('../utils/emailValidation');
/**
 * Authentication Controller
 * Handles login, logout, and token management
 */

/**
 * @route   POST /api/auth/login
 * @desc    Login user and return JWT token
 * @access  Public
 */
const login = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        logger.info('Auth', `Login attempt for email: ${email}`);

        // Validation
        if (!email || !password) {
            logger.warn('Auth', 'Login failed - missing email or password');
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Email and password are required'
            });
        }

        // Find user by email
        logger.db('SELECT', 'users', { email });
        const user = await User.findByEmail(email);

        if (!user) {
            logger.auth('Login', email, false);
            return res.status(401).json({
                error: 'Authentication Failed',
                message: 'Invalid email or password'
            });
        }

        // Check if user is active
        if (!user.is_active) {
            logger.warn('Auth', `Login failed - account disabled for: ${email}`);
            return res.status(403).json({
                error: 'Account Disabled',
                message: 'Your account has been disabled. Please contact admin.'
            });
        }

        // Verify password
        const isPasswordValid = await User.verifyPassword(password, user.password_hash);

        if (!isPasswordValid) {
            logger.auth('Login', email, false);
            return res.status(401).json({
                error: 'Authentication Failed',
                message: 'Invalid email or password'
            });
        }

        // Generate JWT token
        const token = jwt.sign(
            {
                id: user.id,
                email: user.email,
                role: user.role
            },
            process.env.JWT_SECRET,
            {
                expiresIn: process.env.JWT_EXPIRES_IN || '24h'
            }
        );

        logger.auth('Login', email, true);
        logger.success('Auth', { userId: user.id, role: user.role });

        // Update login tracking metadata
        const { query } = require('../config/database');
        await query(
            'UPDATE users SET last_login = CURRENT_TIMESTAMP, login_count = COALESCE(login_count, 0) + 1 WHERE id = $1',
            [user.id]
        );

        // Return user data and token
        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                username: user.username,
                name: user.name,
                email: user.email,
                role: user.role,
                wallet_balance: user.wallet_balance,
                profile_image: user.profile_image
            }
        });

    } catch (error) {
        logger.error('Auth:Login', error, { email: req.body?.email });
        next(error);
    }
};

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user (client-side token removal)
 * @access  Private
 */
const logout = async (req, res) => {
    // Since we're using JWT, logout is handled client-side by removing the token
    // This endpoint is just a placeholder for potential future enhancements
    res.json({
        message: 'Logout successful',
        note: 'Please remove the token from client storage'
    });
};

/**
 * @route   GET /api/auth/me
 * @desc    Get current user profile
 * @access  Private
 */
const getCurrentUser = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'User not found'
            });
        }

        res.json({
            user: {
                id: user.id,
                username: user.username,
                name: user.name,
                email: user.email,
                role: user.role,
                wallet_balance: user.wallet_balance,
                is_active: user.is_active,
                profile_image: user.profile_image,
                created_at: user.created_at
            }
        });

    } catch (error) {
        next(error);
    }
};

/**
 * @route   POST /api/auth/register
 * @desc    Register new blogger user
 * @access  Public
 */
const register = async (req, res, next) => {
    try {
        const { name, email, password, confirm_password, whatsapp, skype } = req.body;

        logger.info('Auth', `Registration attempt for email: ${email}`);

        // Validation
        if (!name || name.trim().length < 2) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Name is required and must be at least 2 characters'
            });
        }

        if (!email || !email.includes('@')) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Valid email address is required'
            });
        }

        if (!password || password.length < 8) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Password must be at least 8 characters'
            });
        }

        if (password !== confirm_password) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Passwords do not match'
            });
        }

        if (!whatsapp || whatsapp.trim().length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'WhatsApp number is required'
            });
        }

        if (!skype || skype.trim().length === 0) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Skype ID is required'
            });
        }

        // Check if email already exists
        const existingUser = await User.findByEmail(email);
        if (existingUser) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Email already registered'
            });
        }

        // Hash password
        const bcrypt = require('bcryptjs');
        const hashedPassword = await bcrypt.hash(password, 10);

        // Import database query
        const { query } = require('../config/database');

        // Create new user with role 'vendor' (blogger)
        const result = await query(
            `INSERT INTO users (name, email, password, whatsapp, skype, role, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'vendor', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             RETURNING id, name, email, role, created_at`,
            [name.trim(), email.toLowerCase().trim(), hashedPassword, whatsapp.trim(), skype.trim()]
        );

        const newUser = result.rows[0];

        // Create wallet for new user
        try {
            await query(
                `INSERT INTO wallets (user_id, balance, created_at, updated_at)
                 VALUES ($1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [newUser.id]
            );
        } catch (walletError) {
            // Wallet might already exist, ignore this error
            logger.warn('Auth', `Wallet creation skipped for user ${newUser.id}: ${walletError.message}`);
        }

        logger.success('Auth', { message: 'User registered successfully', userId: newUser.id });

        res.status(201).json({
            message: 'Registration successful! You can now sign in.',
            user: {
                id: newUser.id,
                name: newUser.name,
                email: newUser.email,
                role: newUser.role
            }
        });

    } catch (error) {
        logger.error('Auth:Register', error, { email: req.body?.email });
        next(error);
    }
};

/**
 * @route   POST /api/auth/register/send-code
 * @desc    Step 1 of signup: validate details, email a 6-digit code
 * @access  Public
 */
const sendSignupCode = async (req, res, next) => {
    try {
        const { name, email, password, confirm_password, whatsapp, skype } = req.body;

        if (!name || name.trim().length < 2) {
            return res.status(400).json({ error: 'Validation Error', message: 'Name is required and must be at least 2 characters' });
        }
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Validation Error', message: 'Valid email address is required' });
        }
        if (!password || password.length < 8) {
            return res.status(400).json({ error: 'Validation Error', message: 'Password must be at least 8 characters' });
        }
        if (password !== confirm_password) {
            return res.status(400).json({ error: 'Validation Error', message: 'Passwords do not match' });
        }
        if (!whatsapp || whatsapp.trim().length === 0) {
            return res.status(400).json({ error: 'Validation Error', message: 'WhatsApp number is required' });
        }
        if (!skype || skype.trim().length === 0) {
            return res.status(400).json({ error: 'Validation Error', message: 'Skype ID is required' });
        }

        const cleanEmail = email.toLowerCase().trim();
        const { query } = require('../config/database');
        // 0. Reject disposable emails and domains that cannot receive mail
        const emailCheck = await validateSignupEmail(cleanEmail);
        if (!emailCheck.ok) {
            return res.status(400).json({ error: 'Validation Error', message: emailCheck.message });
        }
        // 1. One account per email (case-insensitive)
        const existing = await query(
            'SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
            [cleanEmail]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Conflict', message: 'Email already registered' });
        }

        // 2. Resend cooldown: one code per 60 seconds per email
        const pending = await query(
            `SELECT EXTRACT(EPOCH FROM (NOW() - last_sent_at)) AS seconds_since
             FROM pending_signups WHERE LOWER(email) = LOWER($1)`,
            [cleanEmail]
        );
        if (pending.rows.length > 0 && Number(pending.rows[0].seconds_since) < 60) {
            const wait = Math.ceil(60 - Number(pending.rows[0].seconds_since));
            return res.status(429).json({
                error: 'Too Many Requests',
                message: `Please wait ${wait} seconds before requesting another code`
            });
        }

        // 3. Create code + store pending signup (code and password are stored hashed)
        const code = String(crypto.randomInt(100000, 1000000));
        const codeHash = await bcrypt.hash(code, 10);
        const passwordHash = await bcrypt.hash(password, 10);

        await query('DELETE FROM pending_signups WHERE LOWER(email) = LOWER($1)', [cleanEmail]);
        await query(
            `INSERT INTO pending_signups
               (email, name, whatsapp, skype, password_hash, code_hash, attempts, expires_at, last_sent_at)
             VALUES ($1, $2, $3, $4, $5, $6, 0, NOW() + INTERVAL '10 minutes', NOW())`,
            [cleanEmail, name.trim(), whatsapp.trim(), skype.trim(), passwordHash, codeHash]
        );

        // 4. Send the email (local dev without SMTP: print the code in the terminal instead)
        const onRailway = !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
        const devMode = !onRailway && process.env.NODE_ENV === 'development' && !process.env.SMTP_PASSWORD;

        if (devMode) {
            console.log(`🔑 [DEV ONLY] Verification code for ${cleanEmail}: ${code}`);
        } else {
            const sent = await sendVerificationCodeEmail(cleanEmail, name.trim(), code);
            if (!sent) {
                await query('DELETE FROM pending_signups WHERE LOWER(email) = LOWER($1)', [cleanEmail]);
                return res.status(500).json({
                    error: 'Email Failed',
                    message: 'Could not send the verification email. Please try again later.'
                });
            }
        }

        logger.info('Auth', `Signup verification code sent to: ${cleanEmail}`);
        res.json({ message: 'Verification code sent', expires_in_minutes: 10 });

    } catch (error) {
        logger.error('Auth:SendSignupCode', error, { email: req.body?.email });
        next(error);
    }
};

/**
 * @route   POST /api/auth/register/verify
 * @desc    Step 2 of signup: check the code, then create the account
 * @access  Public
 */
const verifySignupCode = async (req, res, next) => {
    try {
        const { email, code } = req.body;

        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Validation Error', message: 'Valid email address is required' });
        }
        if (!code || !/^\d{6}$/.test(String(code).trim())) {
            return res.status(400).json({ error: 'Validation Error', message: 'Enter the 6-digit code from your email' });
        }

        const cleanEmail = email.toLowerCase().trim();
        const { query } = require('../config/database');

        const result = await query(
            'SELECT * FROM pending_signups WHERE LOWER(email) = LOWER($1)',
            [cleanEmail]
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Validation Error', message: 'No pending signup found. Please start again.' });
        }
        const pending = result.rows[0];

        if (new Date(pending.expires_at) < new Date()) {
            await query('DELETE FROM pending_signups WHERE id = $1', [pending.id]);
            return res.status(400).json({ error: 'Validation Error', message: 'This code has expired. Please start again.' });
        }

        if (pending.attempts >= 5) {
            await query('DELETE FROM pending_signups WHERE id = $1', [pending.id]);
            return res.status(429).json({ error: 'Too Many Attempts', message: 'Too many wrong attempts. Please start again.' });
        }

        const codeOk = await bcrypt.compare(String(code).trim(), pending.code_hash);
        if (!codeOk) {
            const attemptsNow = pending.attempts + 1;
            if (attemptsNow >= 5) {
                await query('DELETE FROM pending_signups WHERE id = $1', [pending.id]);
                return res.status(429).json({ error: 'Too Many Attempts', message: 'Too many wrong attempts. Please start again.' });
            }
            await query('UPDATE pending_signups SET attempts = $1 WHERE id = $2', [attemptsNow, pending.id]);
            return res.status(400).json({
                error: 'Validation Error',
                message: `Incorrect code. ${5 - attemptsNow} attempt(s) left.`
            });
        }

        // Code is correct: create the real account (only if the email is still free)
        const created = await query(
            `INSERT INTO users (name, email, password, whatsapp, skype, role, status, created_at, updated_at)
             SELECT $1::text, $2::text, $3::text, $4::text, $5::text, 'vendor', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
             WHERE NOT EXISTS (SELECT 1 FROM users WHERE LOWER(email) = LOWER($2::text))
             RETURNING id, name, email, role, created_at`,
            [pending.name, pending.email, pending.password_hash, pending.whatsapp, pending.skype]
        );

        if (created.rows.length === 0) {
            await query('DELETE FROM pending_signups WHERE id = $1', [pending.id]);
            return res.status(409).json({ error: 'Conflict', message: 'Email already registered' });
        }

        const newUser = created.rows[0];

        try {
            await query(
                `INSERT INTO wallets (user_id, balance, created_at, updated_at)
                 VALUES ($1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [newUser.id]
            );
        } catch (walletError) {
            logger.warn('Auth', `Wallet creation skipped for user ${newUser.id}: ${walletError.message}`);
        }

        await query('DELETE FROM pending_signups WHERE id = $1', [pending.id]);

        logger.success('Auth', { message: 'User registered with verified email', userId: newUser.id });

        res.status(201).json({
            message: 'Account created successfully! You can now sign in.',
            user: { id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role }
        });

    } catch (error) {
        logger.error('Auth:VerifySignupCode', error, { email: req.body?.email });
        next(error);
    }
};
/**
 * @route   PUT /api/auth/change-password
 * @desc    Change current user's password
 * @access  Private
 */
const changePassword = async (req, res, next) => {
    try {
        const { old_password, new_password, confirm_password } = req.body;

        if (!old_password || !new_password || !confirm_password) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'Old password, new password, and confirm password are required'
            });
        }

        if (new_password.length < 8) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'New password must be at least 8 characters'
            });
        }

        if (new_password !== confirm_password) {
            return res.status(400).json({
                error: 'Validation Error',
                message: 'New password and confirm password do not match'
            });
        }

        // Fetch user WITH password column (User.findById does NOT select password)
        const { query } = require('../config/database');
        const userResult = await query(
            'SELECT id, password FROM users WHERE id = $1',
            [req.user.id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                error: 'Not Found',
                message: 'User not found'
            });
        }

        const storedPassword = userResult.rows[0].password;

        const bcrypt = require('bcryptjs');
        const isOldPasswordValid = await bcrypt.compare(old_password, storedPassword);
        if (!isOldPasswordValid) {
            return res.status(401).json({
                error: 'Authentication Failed',
                message: 'Current password is incorrect'
            });
        }

        const hashedPassword = await bcrypt.hash(new_password, 10);

        await query(
            `UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [hashedPassword, req.user.id]
        );

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        next(error);
    }
};

/**
 * @route   GET /api/auth/permissions
 * @desc    Get current user profile permissions
 * @access  Private
 */
const getMyPermissions = async (req, res, next) => {
    try {
        const { query } = require('../config/database');
        const result = await query(
            'SELECT permissions FROM users WHERE id = $1',
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const userPermissionsStr = result.rows[0].permissions;

        // Parse JSONB permissions or default to empty object
        const permissions = typeof userPermissionsStr === 'string'
            ? JSON.parse(userPermissionsStr || '{}')
            : (userPermissionsStr || {});

        res.json({ permissions });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    login,
    logout,
    getCurrentUser,
    register,
    sendSignupCode,
    verifySignupCode,
    changePassword,
    getMyPermissions
};

