const express = require('express');
const router = express.Router();
const messagesController = require('../controllers/messages.controller');
const messageImprovementController = require('../controllers/messageImprovement.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);
router.post('/send', messagesController.send);
router.post('/send-bulk', messagesController.sendBulk);
router.get('/search', messagesController.search);
router.post('/improve', messageImprovementController.improveMessageHandler);
router.post('/:id/react', messagesController.react);
router.post('/:id/read', messagesController.markRead);
router.post('/:chatId/note', messagesController.addNote);
router.delete('/:id', messagesController.deleteMsg);
router.post('/:id/retry', messagesController.retry);

module.exports = router;
