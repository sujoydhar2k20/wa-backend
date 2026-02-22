const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// Webhook verification (GET) - Meta sends this to verify the endpoint
router.get('/', webhookController.verify);

// Webhook handler (POST) - Meta sends incoming messages here
router.post('/', webhookController.handle);

module.exports = router;
