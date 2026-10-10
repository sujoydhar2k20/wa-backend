const express = require('express');
const router = express.Router();
const callsController = require('../controllers/calls.controller');
const { authenticate } = require('../middleware/auth.middleware');

// All routes require authentication
router.use(authenticate);

// Get all call logs (admin view) — must be before :chatId routes
router.get('/logs', callsController.getAllCallLogs);

// Chat-specific call operations
router.post('/:chatId/request-permission', callsController.requestPermission);
router.post('/:chatId/initiate', callsController.initiateCall);
router.get('/:chatId/logs', callsController.getChatCallLogs);

// Call-specific operations
router.post('/:callLogId/terminate', callsController.terminateCall);

module.exports = router;
