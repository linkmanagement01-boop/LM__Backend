const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const managerController = require('../controllers/managerController');
const { authenticate, authorize } = require('../middleware/auth');

// Ensure profile upload directory exists
const profileUploadDir = path.join(__dirname, '../uploads/profiles');
if (!fs.existsSync(profileUploadDir)) {
    fs.mkdirSync(profileUploadDir, { recursive: true });
}

// Profile image upload config
const profileStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, profileUploadDir),
    filename: (req, file, cb) => cb(null, `manager-${req.user.id}-${Date.now()}${path.extname(file.originalname)}`)
});
const profileUpload = multer({ storage: profileStorage, limits: { fileSize: 2 * 1024 * 1024 } });

// All routes require Manager role
router.use(authenticate, authorize('Manager'));

// ==================== DASHBOARD ====================
router.get('/dashboard', managerController.getDashboardStats);

// ==================== TEAM MEMBER LOOKUP ====================
router.get('/team-members', managerController.getTeamMembers);
router.get('/writers', managerController.getWriters);
router.get('/bloggers', managerController.getBloggers);

// ==================== TASK MANAGEMENT ====================
router.get('/tasks', managerController.getTasks);
router.get('/tasks/:id', managerController.getTaskById);

// ==================== ORDER MANAGEMENT ====================
// Get all orders with full data
router.get('/orders', managerController.getOrders);
// Get order details with full workflow
router.get('/orders/:id/details', managerController.getOrderDetails);
// Update an order
router.patch('/orders/:id', managerController.updateOrder);
// Delete an order permanently
router.delete('/orders/:id', managerController.deleteOrder);
// Get pending orders from bloggers
router.get('/pending-from-bloggers', managerController.getPendingFromBloggers);
// Get pending orders from teams
router.get('/pending-from-teams', managerController.getPendingFromTeams);
// Get pending orders from writers
router.get('/pending-from-writers', managerController.getPendingFromWriters);
// Get rejected orders
router.get('/rejected-orders', managerController.getRejectedOrders);
// Get orders rejected by writers
router.get('/rejected-orders/writers', managerController.getRejectedWriterOrders);

// WORKFLOW STEP 1: Create Order and push to Team
router.post('/orders', managerController.createOrder);
// SUPER WORKFLOW: Create order and push directly to Writer or Blogger (bypass steps)
router.post('/orders/create/chain', managerController.createOrderChain);
router.patch('/tasks/:id/assign-team', managerController.assignToTeam);

// WORKFLOW STEP 2: Approve/Reject Team submission
router.patch('/tasks/:id/approve-team', managerController.approveTeamSubmission);
router.patch('/tasks/:id/reject-team', managerController.rejectTeamSubmission);

// WORKFLOW STEP 3: Approve Team submission and assign to Writer
router.patch('/tasks/:id/assign', managerController.assignToWriter);

// Approval 2: Content approval
router.patch('/tasks/:id/approve-content', managerController.approveContent);
router.patch('/tasks/:id/return-to-writer', managerController.returnToWriter);
router.patch('/tasks/:id/reject-writer', managerController.rejectWriterSubmission);

// WORKFLOW STEP 5: Push to Bloggers (auto-routes to site owners)
router.post('/tasks/:id/push-to-bloggers', managerController.pushToBloggers);

// Approval 3: Final verification
router.patch('/tasks/:id/finalize', managerController.finalizeTask);

// Rejection
router.patch('/tasks/:id/reject', managerController.rejectTask);

// ==================== WITHDRAWAL MANAGEMENT ====================
router.get('/withdrawals', managerController.getWithdrawals);
router.patch('/withdrawals/:id/approve', managerController.approveWithdrawal);
router.patch('/withdrawals/:id/reject', managerController.rejectWithdrawal);

// ==================== WEBSITES/SITES MANAGEMENT ====================
router.get('/websites', managerController.getWebsites);

// ==================== PROFILE MANAGEMENT ====================
router.get('/profile', managerController.getProfile);
router.put('/profile', managerController.updateProfile);
router.post('/profile/image', profileUpload.single('profile_image'), managerController.uploadProfileImage);

// ==================== BLOGGER SUBMISSION WORKFLOW ====================
// Get blogger submission detail for review (Screenshot 3)
router.get('/blogger-submissions/:id', managerController.getBloggerSubmissionDetail);
// Finalize blogger submission - mark complete and credit blogger
router.post('/blogger-submissions/:id/finalize', managerController.finalizeFromBlogger);
// Reject blogger submission - send back to blogger with reason
router.post('/blogger-submissions/:id/reject', managerController.rejectBloggerSubmission);

module.exports = router;

