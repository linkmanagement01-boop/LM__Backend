/**
 * Marketplace support chat – staff side (shared inbox for managers and admins)
 * Mounted at /api/support
 */
const express = require('express');
const s = require('../controllers/supportController');
const { authenticate, authorize } = require('../middleware/auth');
const { supportUpload } = require('../utils/supportUpload');

const router = express.Router();
router.use(authenticate, authorize('Manager', 'Admin', 'Super_admin'));

router.get('/conversations', s.staffList);
router.get('/unread', s.staffUnread);
router.post('/start', s.staffStart);
router.post('/upload', supportUpload, s.uploadFile);
router.get('/conversations/:id', s.staffConversation);
router.post('/conversations/:id/messages', s.staffSend);
router.post('/conversations/:id/read', s.staffRead);

module.exports = router;
