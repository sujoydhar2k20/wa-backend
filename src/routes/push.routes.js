const express = require('express');
const router = express.Router();
const pushController = require('../controllers/push.controller');
const { authenticate } = require('../middleware/auth.middleware');

// GET VAPID public key (no auth needed so frontend can get it before/during login if needed, or with auth)
router.get('/vapid-public-key', authenticate, pushController.getVapidPublicKey);

// Subscribe and Unsubscribe (requires auth to associate subscription with the user)
router.post('/subscribe', authenticate, pushController.subscribe);
router.post('/unsubscribe', authenticate, pushController.unsubscribe);

module.exports = router;
