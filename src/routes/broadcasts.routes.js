const express = require('express');
const router = express.Router();
const broadcastsController = require('../controllers/broadcasts.controller');
const { authenticate, requireAdmin } = require('../middleware/auth.middleware');

router.use(authenticate);
router.get('/', broadcastsController.list);
router.post('/', requireAdmin, broadcastsController.create);
router.get('/:id', broadcastsController.get);
router.get('/:id/stats', broadcastsController.getStats);
router.post('/:id/send', requireAdmin, broadcastsController.send);
router.post('/:id/test', requireAdmin, broadcastsController.test);

module.exports = router;
