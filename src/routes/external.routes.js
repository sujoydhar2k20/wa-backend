const express = require('express');
const router = express.Router();
const externalController = require('../controllers/external.controller');
const externalAuth = require('../middleware/externalAuth');
const { authenticate, requireAdmin } = require('../middleware/auth.middleware');

// Public Third-Party API Endpoint
router.post('/send-template', externalAuth, externalController.sendTemplate);

// Management Routes (Admin Only)
router.get('/keys', authenticate, requireAdmin, externalController.listKeys);
router.post('/keys', authenticate, requireAdmin, externalController.createKey);
router.patch('/keys/:id', authenticate, requireAdmin, externalController.toggleKey);
router.delete('/keys/:id', authenticate, requireAdmin, externalController.deleteKey);

module.exports = router;
