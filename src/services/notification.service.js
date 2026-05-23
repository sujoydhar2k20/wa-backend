const { Notification, User } = require('../models');
const { getIO } = require('../websocket/socket.server');
const pushService = require('./push.service');
const { logger } = require('../utils/logger');

/**
 * Creates and saves a new notification in the database, sends web push notifications if user DND is disabled,
 * and emits real-time WebSocket events.
 * 
 * @param {Object} data
 * @param {string} data.recipientId MongoDB User ID of the recipient
 * @param {string} data.type 'new_chat' | 'escalation' | 'unread_reminder' | 'repeated_notification'
 * @param {string} data.title Title of the notification
 * @param {string} data.body Body of the notification
 * @param {Object} [data.metadata] Optional metadata object (e.g. { chatId })
 */
async function createNotification({ recipientId, type, title, body, metadata }) {
  try {
    const recipient = await User.findById(recipientId);
    if (!recipient) {
      logger.warn(`Failed to create notification: recipient ${recipientId} not found`);
      return null;
    }

    // 1. Create and save the notification in the database
    const notification = await Notification.create({
      recipientId,
      type,
      title,
      body,
      metadata
    });

    // 2. Determine if recipient has Do Not Disturb (DND) active
    const isDndActive = !!recipient.isDnd;

    // 3. Emit real-time WebSocket notification to the user's specific room
    try {
      const io = getIO();
      io.to(`user:${recipientId}`).emit('notification:new', {
        notification,
        isDndActive
      });
      // Also emit a general notification count update to update tab indicators
      const unreadCount = await Notification.countDocuments({ recipientId, isRead: false });
      io.to(`user:${recipientId}`).emit('notification:unread_count', { unreadCount });
    } catch (socketErr) {
      logger.warn(`Failed to emit socket notification for user ${recipientId}: ${socketErr.message}`);
    }

    // 4. Send web push notification if DND is NOT active
    if (!isDndActive) {
      await pushService.sendPushNotificationToUsers([recipientId.toString()], {
        title,
        body,
        url: metadata?.chatId ? `/chats/${metadata.chatId}` : '/notifications',
        data: {
          notificationId: notification._id.toString(),
          type,
          ...metadata
        }
      });
    } else {
      logger.info(`Skipped Web Push notification for user ${recipient.name} due to DND status`);
    }

    return notification;
  } catch (error) {
    logger.error('Error creating notification:', error);
    throw error;
  }
}

/**
 * Convenience method to notify multiple users at once (e.g. all admins for unassigned chats)
 */
async function notifyMultipleUsers(userIds, { type, title, body, metadata }) {
  const notifications = [];
  for (const id of userIds) {
    try {
      const notif = await createNotification({
        recipientId: id,
        type,
        title,
        body,
        metadata
      });
      if (notif) notifications.push(notif);
    } catch (err) {
      logger.error(`Error sending batch notification to user ${id}: ${err.message}`);
    }
  }
  return notifications;
}

module.exports = {
  createNotification,
  notifyMultipleUsers
};
