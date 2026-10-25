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
router.post('/:id/send', requireAdmin, broadcastsController.send);
router.post('/:id/test', requireAdmin, broadcastsController.test);
router.post('/:id/pause', requireAdmin, broadcastsController.pause);
router.post('/:id/resume', requireAdmin, broadcastsController.resume);
router.get('/:id/messages', broadcastsController.getMessages);
router.get('/:id/messages/failed', broadcastsController.getFailedMessages);
router.get('/:id/batches', broadcastsController.getBatches);
router.post('/:id/retry', requireAdmin, broadcastsController.createRetryBroadcast);

module.exports = router;

