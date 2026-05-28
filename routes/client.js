const express = require('express');
const router = express.Router();
const clientController = require('../controllers/clientController');
const { authenticate, authorize } = require('../middleware/auth');

// All client routes require authentication + client role
router.use(authenticate);
router.use(authorize('Client'));

/**
 * @route   GET /api/client/dashboard
 * @desc    Get client dashboard stats
 */
router.get('/dashboard', clientController.getDashboard);

/**
 * @route   GET /api/client/wallet
 * @desc    Get wallet balance and transaction history
 */
router.get('/wallet', clientController.getWallet);

/**
 * @route   GET /api/client/transactions
 * @desc    Get client transaction history
 */
router.get('/transactions', clientController.getTransactions);

/**
 * @route   POST /api/client/payments/create-order
 * @desc    Create a Razorpay payment order for top-up
 */
router.post('/payments/create-order', clientController.createPaymentOrder);

/**
 * @route   POST /api/client/payments/verify
 * @desc    Verify Razorpay payment and credit wallet
 */
router.post('/payments/verify', clientController.verifyPayment);

/**
 * @route   GET /api/client/sites
 * @desc    Browse all approved sites
 */
router.get('/sites', clientController.getSites);

/**
 * @route   POST /api/client/orders
 * @desc    Create a new client order
 */
router.post('/orders', clientController.createOrder);

/**
 * @route   GET /api/client/orders
 * @desc    Get all orders for the logged-in client
 */
router.get('/orders', clientController.getOrders);

/**
 * @route   GET /api/client/orders/:id
 * @desc    Get single order details
 */
router.get('/orders/:id', clientController.getOrderDetails);

/**
 * @route   GET /api/client/sites/link-completed
 * @desc    Get completed links for client
 */
router.get('/sites/link-completed', clientController.getCompletedLinks);

/**
 * @route   POST /api/client/sites/check-link-status
 * @desc    Check link status
 */
router.post('/sites/check-link-status', clientController.checkLinkStatus);

module.exports = router;
