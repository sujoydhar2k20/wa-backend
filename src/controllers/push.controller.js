const { User } = require('../models');
const { logger } = require('../utils/logger');

/**
 * Returns the Firebase Cloud Messaging Web Push VAPID certificate key.
 * This is used by browsers/PWAs to authorize push notifications.
 */
exports.getVapidPublicKey = (req, res) => {
    try {
        const vapidKey = process.env.FIREBASE_VAPID_KEY;
        if (!vapidKey) {
            return res.status(500).json({ error: 'FCM Web Push VAPID key is not configured on the backend' });
        }
        res.json({ publicKey: vapidKey });
    } catch (error) {
        logger.error(`Error getting FCM VAPID key: ${error.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Registers a device's Firebase Cloud Messaging token to the authenticated user.
 */
exports.subscribe = async (req, res) => {
    try {
        const userId = req.user.id;
        const { token } = req.body;

        if (!token || typeof token !== 'string') {
            return res.status(400).json({ error: 'FCM registration token is required and must be a string' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Initialize fcmTokens array if undefined
        if (!user.fcmTokens) {
            user.fcmTokens = [];
        }

        // Save token if it doesn't already exist for this user
        if (!user.fcmTokens.includes(token)) {
            user.fcmTokens.push(token);
            await user.save();
            logger.info(`Registered FCM token for user ${user.name} (${user.phone})`);
        }

        res.status(201).json({ success: true, message: 'FCM registration token saved successfully' });
    } catch (error) {
        logger.error(`Error registering FCM token: ${error.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * Unregisters a specific device token from the user (e.g. on logout or disabling notifications).
 */
exports.unsubscribe = async (req, res) => {
    try {
        const userId = req.user.id;
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'FCM token is required for unsubscription' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (user.fcmTokens) {
            const originalLength = user.fcmTokens.length;
            user.fcmTokens = user.fcmTokens.filter(t => t !== token);
            
            if (user.fcmTokens.length !== originalLength) {
                await user.save();
                logger.info(`Unregistered FCM token for user ${user.name}`);
            }
        }

        res.status(200).json({ success: true, message: 'FCM token removed successfully' });
    } catch (error) {
        logger.error(`Error removing FCM token: ${error.message}`);
        res.status(500).json({ error: 'Internal server error' });
    }
};
