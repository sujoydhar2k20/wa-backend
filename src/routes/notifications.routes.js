const express = require('express');
const router = express.Router();
const notificationsController = require('../controllers/notifications.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);

// GET /api/notifications
router.get('/', notificationsController.list);

// POST /api/notifications/read
router.post('/read', notificationsController.markRead);

// PATCH /api/notifications/dnd
router.patch('/dnd', notificationsController.toggleDnd);

module.exports = router;
