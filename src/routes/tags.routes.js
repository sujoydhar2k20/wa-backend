const express = require('express');
const router = express.Router();
const tagsController = require('../controllers/tags.controller');
const { authenticate, requireAdmin } = require('../middleware/auth.middleware');

router.use(authenticate);
router.get('/', tagsController.list);
router.post('/', requireAdmin, tagsController.create);
router.put('/:id', requireAdmin, tagsController.update);
router.delete('/:id', requireAdmin, tagsController.remove);
router.post('/chats/:chatId/tags/:tagId', tagsController.addToChat);
router.delete('/chats/:chatId/tags/:tagId', tagsController.removeFromChat);

module.exports = router;
