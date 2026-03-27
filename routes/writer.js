const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const writerController = require('../controllers/writerController');
const { authenticate, authorize } = require('../middleware/auth');

// Configure multer for content file uploads
const contentUploadDir = path.join(__dirname, '../uploads/content-files');
if (!fs.existsSync(contentUploadDir)) {
    fs.mkdirSync(contentUploadDir, { recursive: true });
}

const contentStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, contentUploadDir),
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const contentUpload = multer({
    storage: contentStorage,
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
    fileFilter: (req, file, cb) => {
        const allowed = ['.doc', '.docx', '.pdf', '.txt', '.rtf', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`File type ${ext} not allowed`));
        }
    }
});

// All routes require Writer role
router.use(authenticate, authorize('Writer'));

/**
 * @route   GET /api/writer/tasks
 * @desc    Get my assigned tasks
 * @access  Writer only
 */
router.get('/tasks', writerController.getMyTasks);

/**
 * @route   GET /api/writer/tasks/:id
 * @desc    Get specific task
 * @access  Writer only
 */
router.get('/tasks/:id', writerController.getTaskById);

/**
 * @route   POST /api/writer/tasks/:id/submit-content
 * @desc    Submit content (supports file uploads via multipart/form-data)
 * @access  Writer only
 */
router.post('/tasks/:id/submit-content', contentUpload.any(), writerController.submitContent);

/**
 * @route   PATCH /api/writer/tasks/:id/mark-in-progress
 * @desc    Mark task as in progress
 * @access  Writer only
 */
router.patch('/tasks/:id/mark-in-progress', writerController.markInProgress);

/**
 * @route   GET /api/writer/dashboard
 * @desc    Get dashboard statistics
 * @access  Writer only
 */
router.get('/dashboard', writerController.getDashboardStats);

/**
 * @route   GET /api/writer/completed-orders
 * @desc    Get completed orders
 * @access  Writer only
 */
router.get('/completed-orders', writerController.getCompletedOrders);

/**
 * @route   GET /api/writer/completed-orders/:id
 * @desc    Get specific completed order detail
 * @access  Writer only
 */
router.get('/completed-orders/:id', writerController.getCompletedOrderDetail);

// ==================== PROFILE MANAGEMENT ====================
const profileStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/profiles/'),
    filename: (req, file, cb) => cb(null, `writer-${req.user.id}-${Date.now()}${path.extname(file.originalname)}`)
});
const profileUpload = multer({ storage: profileStorage, limits: { fileSize: 2 * 1024 * 1024 } });

router.get('/profile', writerController.getProfile);
router.put('/profile', writerController.updateProfile);
router.post('/profile/image', profileUpload.single('profile_image'), writerController.uploadProfileImage);

/**
 * @route   POST /api/writer/tasks/:id/reject
 * @desc    Writer rejects an assigned task
 * @access  Writer only
 */
router.post('/tasks/:id/reject', writerController.rejectTask);

module.exports = router;

