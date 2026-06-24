const express = require('express');
const router = express.Router();
const wabasController = require('../controllers/wabas.controller');
const webhookController = require('../controllers/webhook.controller');
const { authenticate, requireAdmin } = require('../middleware/auth.middleware');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

router.use(authenticate);
router.get('/', wabasController.list);
router.post('/', requireAdmin, wabasController.create);
router.get('/all/templates', wabasController.getAllTemplates);
router.get('/:id', wabasController.get);
router.put('/:id', requireAdmin, wabasController.update);
router.delete('/:id', requireAdmin, wabasController.remove);
router.post('/:id/sync-templates', requireAdmin, wabasController.syncTemplates);
router.post('/:id/templates', requireAdmin, wabasController.createTemplate);
router.get('/:id/templates', wabasController.getTemplates);
router.post('/:wabaId/templates/:templateName/header-image', requireAdmin, upload.single('image'), wabasController.uploadTemplateHeaderImage);
router.get('/:id/quota', wabasController.getQuota);
router.get('/:id/webhook', webhookController.verify);
router.post('/:id/webhook', webhookController.handle);
router.post('/embedded-signup/register', requireAdmin, wabasController.embeddedSignup);

module.exports = router;
