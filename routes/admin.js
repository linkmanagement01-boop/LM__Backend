const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const adminController = require('../controllers/adminController');
const adminSitesController = require('../controllers/adminSitesController');
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
    filename: (req, file, cb) => cb(null, `admin-${req.user.id}-${Date.now()}${path.extname(file.originalname)}`)
});
const profileUpload = multer({ storage: profileStorage, limits: { fileSize: 2 * 1024 * 1024 } });

// ==================== WALLET & INVOICE MANAGEMENT (Shared: Admin & Accountant) ====================
const walletAuth = [authenticate, authorize('Admin', 'Accountant')];
router.get('/bloggers-stats', ...walletAuth, adminController.getBloggerStats);
router.get('/wallet/bloggers', ...walletAuth, adminController.getBloggersWallets);
router.get('/wallet/payment-history', ...walletAuth, adminController.getPaymentHistory);
router.get('/wallet/withdrawal-requests', ...walletAuth, adminController.getWithdrawalRequests);
router.get('/wallet/withdrawal-requests/:id', ...walletAuth, adminController.getWithdrawalRequestDetail);
router.put('/wallet/withdrawal-requests/:id/approve', ...walletAuth, adminController.approveWithdrawal);
router.put('/wallet/withdrawal-requests/:id/reject', ...walletAuth, adminController.rejectWithdrawal);
router.get('/wallet/invoices/:id', ...walletAuth, adminController.getInvoiceDetail);
router.get('/wallet/invoices/:id/pdf', ...walletAuth, adminController.downloadInvoicePdf);
router.post('/wallet/recalculate/:userId', ...walletAuth, adminController.recalculateWallet);

// All other routes require securely strict Admin role
router.use(authenticate, authorize('Admin'));

// ==================== ORDERS MANAGEMENT (reuse manager functions) ====================
router.get('/orders', managerController.getOrders);
router.get('/orders/:id/details', managerController.getOrderDetails);
router.patch('/orders/:id', managerController.updateOrder);
router.get('/rejected-orders', managerController.getRejectedOrders);
router.get('/rejected-orders/writers', managerController.getRejectedWriterOrders);

// ==================== USER MANAGEMENT ====================
router.get('/users', adminController.getAllUsers);
router.post('/users', adminController.createUser);
router.put('/users/:id', adminController.updateUser);
router.delete('/users/:id', adminController.deleteUser);
router.put('/users/:id/reset-password', adminController.resetUserPassword);
router.put('/users/:id/change-password', adminController.changeUserPassword);
router.get('/users/:id/permissions', adminController.getUserPermissions);
router.put('/users/:id/permissions', adminController.updateUserPermissions);
router.post('/users/:id/impersonate', adminController.impersonateUser);

// ==================== BLOGGER PERFORMANCE ====================
router.get('/bloggers/:id/performance', adminController.getBloggerPerformance);

// ==================== WEBSITE MANAGEMENT ====================
router.get('/websites', adminController.getAllWebsites);
router.post('/websites', adminController.createWebsite);
router.post('/websites/upload', adminController.upload.single('file'), adminController.uploadWebsitesCSV);
router.get('/websites/:id', adminController.getWebsiteById);
router.put('/websites/:id', adminController.updateWebsite);
router.delete('/websites/:id', adminController.deleteWebsite);

// ==================== SITES EXCEL MANAGEMENT ====================
router.get('/sites/download-format', adminController.downloadSiteFormat);
router.post('/sites/upload-excel', adminController.upload.single('file'), adminController.uploadSitesExcel);
router.post('/sites/upload-excel-preview', adminController.upload.single('file'), adminController.previewSitesExcel);
router.post('/sites/upload-excel-confirm', adminController.confirmSitesExcel);

// ==================== STATISTICS ====================
router.get('/stats', adminController.getStatistics);

// ==================== TASKS (Read-only for admin overview) ====================
router.get('/tasks', adminController.getAllTasks);

// ==================== WITHDRAWALS (Read-only for admin overview) ====================
router.get('/withdrawals', adminController.getAllWithdrawals);

// ==================== PRICE CHARTS MANAGEMENT ====================
router.get('/price-charts', adminController.getAllPriceCharts);
router.post('/price-charts', adminController.createPriceChart);
router.put('/price-charts/:id', adminController.updatePriceChart);
router.delete('/price-charts/:id', adminController.deletePriceChart);

// Wallet endpoints lifted above strict Admin block

// ==================== CREATE ACCOUNT FROM SITES ====================
router.get('/sites/pending-accounts', adminController.getSitesForAccountCreation);
router.post('/sites/create-accounts', adminController.createAccountsFromSites);

// ==================== PENDING BULK REQUESTS ====================
router.get('/sites/pending-bulk', adminController.getPendingBulkRequests);
router.get('/sites/pending-bulk/:id/download', adminController.downloadBulkFile);
router.put('/sites/pending-bulk/:id/accept', adminController.acceptBulkRequest);
router.put('/sites/pending-bulk/:id/reject', adminController.rejectBulkRequest);

// ==================== SITES LIST (View All Sites) ====================
router.get('/sites/list', adminController.getWebsitesList);
router.get('/sites/deleted-list', adminController.getDeletedWebsitesList);
router.put('/sites/:id/delete', adminController.deleteWebsite);
router.put('/sites/:id/restore', adminController.restoreWebsite);

// ==================== CAREERS MANAGEMENT ====================
router.get('/careers', adminController.getCareers);
router.post('/careers', adminController.createCareer);
router.get('/careers/:id', adminController.getCareerById);
router.put('/careers/:id', adminController.updateCareer);
router.delete('/careers/:id', adminController.deleteCareer);

// ==================== FAQs MANAGEMENT ====================
router.get('/faqs', adminController.getFaqs);
router.post('/faqs', adminController.createFaq);
router.get('/faqs/:id', adminController.getFaqById);
router.put('/faqs/:id', adminController.updateFaq);
router.delete('/faqs/:id', adminController.deleteFaq);

// ==================== VIDEOS MANAGEMENT ====================
router.get('/videos', adminController.getVideos);
router.post('/videos', adminController.createVideo);
router.get('/videos/:id', adminController.getVideoById);
router.put('/videos/:id', adminController.updateVideo);
router.delete('/videos/:id', adminController.deleteVideo);

// ==================== COUNTRIES MANAGEMENT ====================
router.get('/countries', adminController.getCountries);
router.post('/countries', adminController.createCountry);
router.get('/countries/:id', adminController.getCountryById);
router.put('/countries/:id', adminController.updateCountry);
router.delete('/countries/:id', adminController.deleteCountry);

// ==================== LINK INSPECTION ====================
router.get('/sites/link-completed', adminSitesController.getCompletedLinks);
router.post('/sites/check-link-status', adminSitesController.checkLinkStatus);
router.post('/sites/bulk-check', adminSitesController.startBulkCheck);
router.get('/sites/bulk-check-status', adminSitesController.getBulkCheckStatus);
router.post('/sites/stop-bulk-check', adminSitesController.stopBulkCheck);

// ==================== PROFILE MANAGEMENT ====================
router.get('/profile', adminController.getProfile);
router.put('/profile', adminController.updateProfile);
router.post('/profile/image', profileUpload.single('profile_image'), adminController.uploadProfileImage);

module.exports = router;

