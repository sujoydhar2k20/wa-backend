const admin = require('firebase-admin');
const { logger } = require('../utils/logger');
const { User } = require('../models');

let isInitialized = false;

/**
 * Initialize Firebase Admin SDK.
 * Reads configurations from environment variables.
 */
function configureFirebase() {
    if (isInitialized) return;

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (privateKey) {
        // Handle newline formatting from environment string
        privateKey = privateKey.replace(/\\n/g, '\n');
    }

    if (projectId && clientEmail && privateKey) {
        try {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId,
                    clientEmail,
                    privateKey
                })
            });
            isInitialized = true;
            logger.info('Firebase Admin SDK initialized successfully.');
        } catch (error) {
            logger.error(`Failed to initialize Firebase Admin SDK: ${error.message}`);
        }
    } else {
        logger.warn('Firebase Cloud Messaging VAPID/Credentials are not configured. Push notifications will be bypassed.');
    }
}

// Run initialization immediately on import
configureFirebase();

/**
 * Sends FCM push notifications to specific users on all their registered devices (multicast).
 * Automatically cleans up invalid or unregistered FCM tokens.
 * 
 * @param {Array<string>} userIds Array of MongoDB User ObjectIds
 * @param {Object} payload Payload details
 * @param {string} payload.title Notification title
 * @param {string} payload.body Notification body
 * @param {string} [payload.url] Click action redirection URL
 * @param {Object} [payload.data] Additional data object
 */
async function sendPushNotificationToUsers(userIds, payload) {
    if (!isInitialized) {
        logger.info('FCM not initialized. Bypassing push notifications.');
        return;
    }

    try {
        const users = await User.find({ _id: { $in: userIds } });
        if (users.length === 0) return;

        // Map users and collect tokens
        const tokenToUserMap = new Map();
        let allTokens = [];

        for (const user of users) {
            if (user.fcmTokens && user.fcmTokens.length > 0) {
                user.fcmTokens.forEach(token => {
                    allTokens.push(token);
                    tokenToUserMap.set(token, user);
                });
            }
        }

        if (allTokens.length === 0) {
            logger.info('No FCM tokens registered for target users.');
            return;
        }

        // Format FCM Multicast Message
        // For mobile and web clients, we include notification details and custom data
        const message = {
            notification: {
                title: payload.title,
                body: payload.body,
            },
            data: {
                url: payload.url || '',
                title: payload.title,
                body: payload.body,
                ...(payload.data || {}),
            },
            tokens: allTokens,
        };

        // Send via Firebase
        logger.info(`Sending FCM multicast push notification to ${allTokens.length} devices...`);
        const response = await admin.messaging().sendEachForMulticast(message);
        logger.info(`FCM Send results: success=${response.successCount}, failure=${response.failureCount}`);

        // Clean up invalid or unregistered tokens
        if (response.failureCount > 0) {
            const invalidTokensByUser = new Map();

            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    const token = allTokens[idx];
                    const error = resp.error;
                    const code = error?.code;

                    logger.warn(`FCM delivery failed for token at index ${idx}: code=${code}, message=${error?.message}`);

                    // Clean up tokens that are invalid, expired, or unregistered
                    const isStale = code === 'messaging/registration-token-not-registered' || 
                                    code === 'messaging/invalid-registration-token';
                    
                    if (isStale) {
                        const user = tokenToUserMap.get(token);
                        if (user) {
                            if (!invalidTokensByUser.has(user._id)) {
                                invalidTokensByUser.set(user._id, []);
                            }
                            invalidTokensByUser.get(user._id).push(token);
                        }
                    }
                }
            });

            // Run DB updates in parallel to remove invalid tokens
            if (invalidTokensByUser.size > 0) {
                const cleanupPromises = [];
                for (const [userId, tokens] of invalidTokensByUser.entries()) {
                    logger.info(`Removing ${tokens.length} stale FCM tokens for user ${userId}`);
                    cleanupPromises.push(
                        User.findByIdAndUpdate(userId, {
                            $pull: { fcmTokens: { $in: tokens } }
                        })
                    );
                }
                await Promise.all(cleanupPromises).catch(err => {
                    logger.error(`Error cleaning up stale FCM tokens: ${err.message}`);
                });
            }
        }
    } catch (err) {
        logger.error(`Error sending FCM notifications: ${err.message}`);
    }
}

module.exports = {
    configureFirebase,
    sendPushNotificationToUsers
};
