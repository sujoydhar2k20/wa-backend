const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');
const { verifyMetaSignature } = require('../middleware/metaSignature.middleware');

// Webhook verification (GET) - Meta sends this to verify the endpoint
router.get('/', webhookController.verify);

// Webhook handler (POST) - Meta sends incoming messages here
// Only requests signed by Meta (X-Hub-Signature-256) are processed.
router.post('/', verifyMetaSignature, webhookController.handle);

module.exports = router;
