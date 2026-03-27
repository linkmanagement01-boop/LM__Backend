const express = require('express');
const router = express.Router();
const teamController = require('../controllers/teamController');
const { authenticate, authorize } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');

// Configure multer for profile image uploads
const profileUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR ? path.join(process.env.UPLOAD_DIR, 'profiles') : 'uploads/profiles/'),
        filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
    })
});

// All routes require Team role
router.use(authenticate, authorize('Team'));

// Dashboard
router.get('/dashboard', teamController.getDashboardStats);

// ==================== PROFILE MANAGEMENT ====================
router.get('/profile', teamController.getProfile);
router.put('/profile', teamController.updateProfile);
router.post('/profile/image', profileUpload.single('profile_image'), teamController.uploadProfileImage);
router.get('/permissions', teamController.getMyPermissions);

// ==================== ORDER NOTIFICATIONS (Push to Manager Flow) ====================
// Get orders pushed by Manager (Order Added Notifications)
router.get('/order-notifications', teamController.getOrderNotifications);
// Get specific order details for Push to Manager page
router.get('/order-notifications/:id', teamController.getTaskForPush);
// Submit selected websites for an order
router.post('/order-notifications/:id/submit', teamController.submitWebsitesToManager);

// ==================== COMPLETED ORDERS ====================
router.get('/completed-orders', teamController.getCompletedOrders);
router.get('/completed-orders/:id', teamController.getCompletedOrderDetail);

// ==================== REJECTED LINKS ====================
router.get('/rejected-links', teamController.getRejectedLinks);

// ==================== LEGACY/EXISTING ROUTES ====================
// Get assigned tasks from Manager
router.get('/assigned', teamController.getAssignedTasks);

// Get all my tasks
router.get('/tasks', teamController.getMyTasks);

// Create new task (legacy)
router.post('/tasks', teamController.createTask);

// Get specific task
router.get('/tasks/:id', teamController.getTaskById);

// WORKFLOW STEP 2: Submit selected website back to Manager
router.patch('/tasks/:id/submit-website', teamController.submitWebsite);

// Get available websites for selection
router.get('/websites', teamController.getWebsites);

// Add new website
router.post('/websites', teamController.addWebsite);

// ==================== THREADS ====================
router.get('/managers', teamController.getManagers);
router.get('/threads', teamController.getThreads);
router.post('/threads', teamController.createThread);
router.get('/threads/:id/messages', teamController.getThreadMessages);
router.post('/threads/:id/messages', teamController.sendMessage);

module.exports = router;
