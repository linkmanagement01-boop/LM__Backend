/**
 * Outreach Team panel – a member sees and works only the tasks a manager assigned to them.
 */
const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const o = require('../controllers/marketplaceOutreachController');

router.use(authenticate, authorize('Outreach'));

router.get('/dashboard', o.memberDashboard);
router.get('/tasks', o.memberTasks);
router.put('/tasks/:id', o.memberSave);
router.post('/tasks/:id/submit', o.memberSubmit);
router.get('/notifications', o.memberNotifications);
router.post('/notifications/read', o.memberReadNotifications);

module.exports = router;
