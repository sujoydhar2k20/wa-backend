const express = require('express');
const router = express.Router();
const broadcastListsController = require('../controllers/broadcastLists.controller');
const { authenticate, requireAdmin } = require('../middleware/auth.middleware');
const upload = require('../middleware/upload.middleware');

router.use(authenticate);
router.get('/', broadcastListsController.list);
router.post('/', requireAdmin, broadcastListsController.create);
router.get('/:id', broadcastListsController.get);
router.put('/:id', requireAdmin, broadcastListsController.update);
router.delete('/:id', requireAdmin, broadcastListsController.remove);
router.post('/:id/import', requireAdmin, upload.single('file'), broadcastListsController.importMembers);
router.post('/:id/members/add', requireAdmin, broadcastListsController.addMembers);
router.get('/:id/members', broadcastListsController.getMembers);

module.exports = router;
