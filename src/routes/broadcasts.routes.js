const express = require('express');
const router = express.Router();
const broadcastsController = require('../controllers/broadcasts.controller');
const { authenticate, requireAdmin } = require('../middleware/auth.middleware');

router.use(authenticate);
router.get('/', broadcastsController.list);
router.post('/', requireAdmin, broadcastsController.create);
router.post('/bulk-delete', requireAdmin, broadcastsController.bulkDelete);
router.get('/stats/today', broadcastsController.getTodayStats);
router.get('/status-counts', broadcastsController.getStatusCounts);
router.get('/:id', broadcastsController.get);
router.get('/:id/stats', broadcastsController.getStats);
router.get('/:id/messages', broadcastsController.getMessages);
router.get('/:id/failed-messages', broadcastsController.getFailedMessages);
router.get('/:id/error-analytics', broadcastsController.getErrorAnalytics);
router.get('/:id/batches', broadcastsController.getBatches);
router.post('/:id/send', requireAdmin, broadcastsController.send);
router.post('/:id/test', requireAdmin, broadcastsController.test);
router.post('/:id/retry-failed', requireAdmin, broadcastsController.retryFailed);
router.post('/:id/stop', requireAdmin, broadcastsController.stopBroadcast);

module.exports = router;

