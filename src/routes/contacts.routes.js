const express = require('express');
const router = express.Router();
const contactsController = require('../controllers/contacts.controller');
const { authenticate } = require('../middleware/auth.middleware');
const upload = require('../middleware/upload.middleware');

router.use(authenticate);
router.get('/', contactsController.list);
router.get('/:id', contactsController.get);
router.put('/:id', contactsController.update);
router.post('/:id/opt-out', contactsController.optOut);
router.post('/:id/opt-in', contactsController.optIn);
router.post('/:id/block', contactsController.block);
router.delete('/:id', contactsController.remove);
router.post('/bulk-delete', contactsController.bulkDelete);
router.post('/import', upload.single('file'), contactsController.import);

module.exports = router;
