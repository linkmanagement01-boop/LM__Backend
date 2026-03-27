const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bloggerController = require('../controllers/bloggerController');
const { authenticate, authorize } = require('../middleware/auth');

// Configure multer for profile image uploads
const profileUploadDir = path.join(__dirname, '../uploads/profiles');
if (!fs.existsSync(profileUploadDir)) {
    fs.mkdirSync(profileUploadDir, { recursive: true });
}

const profileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, profileUploadDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `profile_${req.user.id}_${Date.now()}${ext}`);
    }
});

const profileUpload = multer({
    storage: profileStorage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only JPEG, PNG, and WebP images are allowed'), false);
        }
    }
});

// All routes require Blogger role
router.use(authenticate, authorize('Blogger'));

// ==================== STATISTICS ====================
router.get('/stats', bloggerController.getStatistics);

// ==================== TASK MANAGEMENT ====================
router.get('/tasks', bloggerController.getMyTasks);
router.get('/tasks/:id', bloggerController.getTaskById);
router.post('/tasks/:id/submit-link', bloggerController.submitLiveLink);
router.post('/tasks/:id/reject', bloggerController.rejectTask);
router.post('/check-link', bloggerController.checkLinkStatus);

// ==================== WALLET MANAGEMENT ====================
router.get('/wallet', bloggerController.getWallet);
router.post('/withdrawals/request', bloggerController.requestWithdrawal);
router.get('/withdrawals', bloggerController.getWithdrawals);
router.get('/invoices', bloggerController.getInvoices);
router.get('/invoices/:id', bloggerController.getInvoiceDetail);
router.get('/invoices/:id/pdf', bloggerController.downloadInvoicePdf);

// ==================== SITES MANAGEMENT ====================
router.get('/sites', bloggerController.getMySites);
router.post('/sites', bloggerController.addSite);
router.put('/sites/:id', bloggerController.updateSite);
router.delete('/sites/:id', bloggerController.deleteSite);

// ==================== NOTIFICATIONS ====================
router.get('/notifications', bloggerController.getNotifications);
router.patch('/notifications/:id/read', bloggerController.markNotificationRead);
router.patch('/notifications/read-all', bloggerController.markAllNotificationsRead);

// ==================== PAYMENT DETAILS ====================
router.get('/payment-details', bloggerController.getPaymentDetails);
router.put('/payment-details', bloggerController.updatePaymentDetails);

// ==================== REQUEST WITHDRAWAL ====================
router.get('/withdrawable-orders', bloggerController.getWithdrawableOrders);
router.post('/submit-withdrawal', bloggerController.submitWithdrawalRequest);

// ==================== PROFILE MANAGEMENT ====================
router.get('/profile', bloggerController.getProfile);
router.put('/profile', bloggerController.updateProfile);
router.post('/profile/image', profileUpload.single('profile_image'), bloggerController.uploadProfileImage);
router.put('/change-password', bloggerController.changePassword);
router.get('/countries', bloggerController.getCountries);

// ==================== BULK SITES UPLOAD ====================
// Configure multer for bulk sites uploads
const bulkSitesUploadDir = path.join(__dirname, '../uploads/bulk-sites');
if (!fs.existsSync(bulkSitesUploadDir)) {
    fs.mkdirSync(bulkSitesUploadDir, { recursive: true });
}

const bulkSitesStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, bulkSitesUploadDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `bulk_${req.user.id}_${Date.now()}${ext}`);
    }
});

const bulkSitesUpload = multer({
    storage: bulkSitesStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel'
        ];
        if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(xlsx|xls)$/i)) {
            cb(null, true);
        } else {
            cb(new Error('Only Excel files (.xlsx, .xls) are allowed'), false);
        }
    }
});

router.post('/bulk-sites/upload', bulkSitesUpload.single('file'), bloggerController.uploadBulkSitesFile);
router.get('/bulk-sites/history', bloggerController.getBulkUploadHistory);

module.exports = router;
