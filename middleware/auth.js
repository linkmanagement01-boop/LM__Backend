const jwt = require('jsonwebtoken');

/**
 * JWT Authentication Middleware
 * Verifies JWT token and attaches user info to request
 */
const authenticate = (req, res, next) => {
    try {
        // Get token from header or query parameter (for file downloads)
        const authHeader = req.headers.authorization;
        let token = null;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7); // Remove 'Bearer ' prefix
        } else if (req.query.token) {
            // Support token in query params for file downloads (window.open can't set headers)
            token = req.query.token;
        }

        if (!token) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'No token provided'
            });
        }

        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Attach user info to request
        req.user = {
            id: decoded.id,
            email: decoded.email,
            role: decoded.role
        };

        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Token expired'
            });
        }

        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Invalid token'
        });
    }
};

/**
 * Role-Based Access Control (RBAC) Middleware
 * @param {string[]} allowedRoles - Array of roles that can access the route
 */
const authorize = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Authentication required'
            });
        }

        // Normalize role comparison: DB stores lowercase roles ('manager', 'vendor', 'writer', 'team')
        // but routes use capitalized names ('Manager', 'Blogger', 'Writer', 'Team')
        // Also map legacy 'vendor' role to 'Blogger'
        const userRole = (req.user.role || '').toLowerCase();
        const normalizedAllowed = allowedRoles.map(r => r.toLowerCase());
        
        // Map 'vendor' to 'blogger' for role matching
        const effectiveRole = userRole === 'vendor' ? 'blogger' : userRole;

        if (!normalizedAllowed.includes(effectiveRole)) {
            return res.status(403).json({
                error: 'Forbidden',
                message: `Access denied. Required role: ${allowedRoles.join(' or ')}`
            });
        }

        next();
    };
};

module.exports = {
    authenticate,
    authorize
};
