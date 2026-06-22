const express = require('express');
const router = express.Router();
const chatsController = require('../controllers/chats.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);
router.get('/', chatsController.list);
router.get('/stats', chatsController.stats);
router.get('/search', chatsController.search);
router.get('/all-auto-messages', chatsController.getAllAutoMessages);
router.delete('/all-auto-messages', chatsController.deleteAllAutoMessages);
router.get('/:id', chatsController.get);
router.post('/:id/assign', chatsController.assign);
router.post('/:id/transfer', chatsController.transfer);
router.post('/:id/close', chatsController.close);
router.post('/:id/reopen', chatsController.reopen);
router.post('/:id/read', chatsController.markRead);
router.post('/:id/unread', chatsController.markUnread);
router.get('/:id/messages', chatsController.getMessages);
router.get('/:id/activities', chatsController.getActivities);
router.get('/:id/auto-messages', chatsController.getAutoMessages);
router.patch('/:id/dnd', chatsController.toggleDnd);

module.exports = router;
