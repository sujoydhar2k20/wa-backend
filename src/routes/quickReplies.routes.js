const express = require('express');
const router = express.Router();
const quickRepliesController = require('../controllers/quickReplies.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);

router.get('/', quickRepliesController.list);
router.post('/', quickRepliesController.create);
router.put('/:id', quickRepliesController.update);
router.delete('/:id', quickRepliesController.remove);

module.exports = router;
