const express = require('express');
const router = express.Router();
const calls = require('../controllers/calls.controller');
const { authenticate, requireAdminOrStaff } = require('../middleware/auth.middleware');

// Signed-link playback (no Authorization header possible from <audio>); must be before authenticate
router.get('/recordings/:callLogId', calls.streamRecording);

router.use(authenticate, requireAdminOrStaff);

router.get('/me/sip', calls.mySip);
router.get('/logs', calls.allLogs);
router.get('/:callLogId/recording-url', calls.recordingUrl);
router.post('/:callLogId/decline', calls.declineCall);
router.get('/:chatId/status', calls.chatStatus);
router.get('/:chatId/logs', calls.chatLogs);
router.post('/:chatId/request-permission', calls.requestPermission);
router.post('/:chatId/initiate', calls.initiate);

module.exports = router;
