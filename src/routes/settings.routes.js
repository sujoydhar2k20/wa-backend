const express = require('express');
const router = express.Router();
const aiSettingsController = require('../controllers/aiSettings.controller');
const { authenticate, authorize } = require('../middleware/auth.middleware');

router.use(authenticate);
// Ensure only admins can modify AI settings
router.use(authorize('admin', 'superadmin'));

router.get('/ai', aiSettingsController.getAiSettings);
router.put('/ai', aiSettingsController.updateAiSettings);

module.exports = router;
