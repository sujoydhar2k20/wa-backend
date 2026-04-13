const express = require('express');
const router = express.Router();

router.use('/auth', require('./auth.routes'));
router.use('/users', require('./users.routes'));
router.use('/wabas', require('./wabas.routes'));
router.use('/chats', require('./chats.routes'));
router.use('/messages', require('./messages.routes'));
router.use('/tags', require('./tags.routes'));
router.use('/contacts', require('./contacts.routes'));
router.use('/broadcast-lists', require('./broadcastLists.routes'));
router.use('/broadcasts', require('./broadcasts.routes'));
router.use('/bot', require('./bot.routes'));
router.use('/products', require('./products.routes'));
router.use('/rates', require('./rates.routes'));
router.use('/notes', require('./notes.routes'));
router.use('/upload', require('./upload.routes'));
router.use('/webhooks/whatsapp', require('./webhook.routes'));
router.use('/push', require('./push.routes'));
router.use('/proxy', require('./proxy.routes'));
router.use('/external', require('./external.routes'));
router.use('/quick-replies', require('./quickReplies.routes'));

module.exports = router;
