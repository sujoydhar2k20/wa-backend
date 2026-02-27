const webpush = require('web-push');
const { logger } = require('../utils/logger');
const { User } = require('../models');

// Configure web-push with VAPID keys
// This function should be called during app initialization or first use
function configureWebPush() {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
        logger.warn('VAPID keys not configured. Push notifications will not work.');
        return;
    }
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
}

// Ensure configured, though normally this would be in server.js, we can just run it when the file loads or on first send
configureWebPush();

/**
 * Send a push notification to specific users
 * @param {Array<string>} userIds Array of MongoDB User ObjectIds
 * @param {Object} payload Payload object to send
 */
async function sendPushNotificationToUsers(userIds, payload) {
    try {
        const payloadString = JSON.stringify(payload);
        const users = await User.find({ _id: { $in: userIds } });

        for (const user of users) {
            if (user.pushSubscriptions && user.pushSubscriptions.length > 0) {
                const invalidSubscriptions = [];

                for (const subscription of user.pushSubscriptions) {
                    try {
                        await webpush.sendNotification(subscription, payloadString);
                    } catch (error) {
                        logger.error(`Failed to send push notification to user ${user.name}: ${error.message}`);
                        // If subscription is invalid/expired (HTTP 410 or 404), mark it for removal
                        if (error.statusCode === 410 || error.statusCode === 404) {
                            invalidSubscriptions.push(subscription);
                        }
                    }
                }

                // Clean up invalid subscriptions
                if (invalidSubscriptions.length > 0) {
                    user.pushSubscriptions = user.pushSubscriptions.filter(
                        sub => !invalidSubscriptions.some(invalidSub => invalidSub.endpoint === sub.endpoint)
                    );
                    await user.save();
                }
            }
        }
    } catch (error) {
        logger.error(`Error sending push notifications: ${error.message}`);
    }
}

module.exports = {
    configureWebPush,
    sendPushNotificationToUsers
};
