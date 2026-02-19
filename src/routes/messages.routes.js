const express = require('express');
const router = express.Router();
const messagesController = require('../controllers/messages.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);
router.post('/send', messagesController.send);
router.get('/search', messagesController.search);
router.post('/:id/react', messagesController.react);
router.post('/:id/read', messagesController.markRead);

module.exports = router;
