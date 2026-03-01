const express = require('express');
const router = express.Router();
const wabasController = require('../controllers/wabas.controller');
const webhookController = require('../controllers/webhook.controller');
const { authenticate, requireAdmin } = require('../middleware/auth.middleware');

router.use(authenticate);
router.get('/', wabasController.list);
router.post('/', requireAdmin, wabasController.create);
router.get('/all/templates', wabasController.getAllTemplates);
router.get('/:id', wabasController.get);
router.put('/:id', requireAdmin, wabasController.update);
router.post('/:id/sync-templates', requireAdmin, wabasController.syncTemplates);
router.get('/:id/templates', wabasController.getTemplates);
router.get('/:id/webhook', webhookController.verify);
router.post('/:id/webhook', webhookController.handle);
router.post('/embedded-signup/register', requireAdmin, wabasController.embeddedSignup);

module.exports = router;
