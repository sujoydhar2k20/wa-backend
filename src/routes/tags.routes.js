const express = require('express');
const router = express.Router();
const tagsController = require('../controllers/tags.controller');
const { authenticate, requireAdminOrStaff } = require('../middleware/auth.middleware');

router.use(authenticate);
router.get('/', tagsController.list);
router.post('/', requireAdminOrStaff, tagsController.create);
router.put('/:id', requireAdminOrStaff, tagsController.update);
router.delete('/:id', requireAdminOrStaff, tagsController.remove);
router.post('/chats/:chatId/tags/:tagId', tagsController.addToChat);
router.delete('/chats/:chatId/tags/:tagId', tagsController.removeFromChat);

module.exports = router;
