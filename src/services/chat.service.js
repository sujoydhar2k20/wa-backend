const { Chat, ChatActivity, User } = require('../models');
const { getIO } = require('../websocket/socket.server');
const { logger } = require('../utils/logger');
const { isMonthly } = require('../utils/tag');

async function checkAndCloseExpiredChats() {
    try {
        const now = new Date();
        // Find chats that are open but their session window expired
        const expiredChats = await Chat.find({
            status: { $ne: 'closed' },
            sessionExpiresAt: { $lt: now }
        });

        if (expiredChats.length === 0) {
            return;
        }

        logger.info(`Found ${expiredChats.length} expired chats to close.`);

        for (const chat of expiredChats) {
            chat.status = 'closed';
            await chat.save();

            // Log activity
            await ChatActivity.create({
                chatId: chat._id,
                type: 'auto_closed',
                details: { reason: 'session_expired' },
            });

            // Emit socket event to update UI in real-time
            try {
                const io = getIO();
                io.emit('chat:updated', { chat });
            } catch (e) {
                logger.warn('Socket emit failed for auto-closed chat:', e.message);
            }
        }
    } catch (error) {
        logger.error('Error in checkAndCloseExpiredChats:', error);
    }
}

async function checkAndTransferNewChats() {
    try {
        const thresholdMinutes = 2; // threshold in minutes
        const threshold = new Date();
        threshold.setMinutes(threshold.getMinutes() - thresholdMinutes);

        // Find open chats assigned to staff where no response has been sent yet
        // and the last customer message was sent more than threshold ago.
        const chatsToTransfer = await Chat.find({
            status: 'open',
            assignedTo: { $ne: null },
            lastStaffMessageAt: null, // No response yet
            lastCustomerMessageAt: { $lt: threshold }
        });

        if (chatsToTransfer.length === 0) {
            return;
        }

        logger.info(`Found ${chatsToTransfer.length} inactive new chats to transfer.`);

        for (const chat of chatsToTransfer) {
            if (await isMonthly({ chat })) {
                logger.info(`Chat ${chat._id} has monthly tag. Skipping auto-transfer.`);
                continue;
            }
            const oldStaffId = chat.assignedTo;

            // Find other staff on the same WABA
            const staffMembers = await User.find({
                _id: { $ne: oldStaffId },
                isActive: true,
                role: 'staff',
                assignedWabaId: chat.wabaId,
            }).select('_id').lean();

            if (staffMembers.length > 0) {
                // Determine least loaded staff member
                const chatCounts = await Promise.all(
                    staffMembers.map(async (staff) => {
                        const count = await Chat.countDocuments({
                            assignedTo: staff._id,
                            status: { $ne: 'closed' },
                        });
                        return { staffId: staff._id, count };
                    })
                );

                chatCounts.sort((a, b) => a.count - b.count);
                const leastLoaded = chatCounts[0];

                 // Transfer chat
                 chat.assignedTo = leastLoaded.staffId;
                 await chat.save();
 
                 // Log activity
                 await ChatActivity.create({
                     chatId: chat._id,
                     type: 'auto_transferred',
                     details: {
                         fromStaffId: oldStaffId,
                         toStaffId: leastLoaded.staffId,
                         reason: 'staff_no_response'
                     },
                 });
 
                 // Create escalation notification
                 try {
                     const notificationService = require('./notification.service');
                     const chatWithContact = await Chat.findById(chat._id).populate('contactId');
                     const customerName = chatWithContact?.contactId?.name || chatWithContact?.contactId?.nameOnWhatsApp || chat.phoneNumber || 'customer';
                     
                     await notificationService.createNotification({
                         recipientId: leastLoaded.staffId,
                         type: 'escalation',
                         title: 'Escalation Alert',
                         body: `Chat with ${customerName} has been escalated to you`,
                         metadata: { chatId: chat._id.toString() }
                     });
                 } catch (notifErr) {
                     logger.error(`Failed to create escalation notification: ${notifErr.message}`);
                 }
 
                 // Emit socket event
                 try {
                     const io = getIO();
                     const updatedChat = await Chat.findById(chat._id)
                         .populate('assignedTo', 'name phone')
                         .populate('contactId', 'name nameOnWhatsApp profilePicture');
 
                     io.emit('chat:update', {
                         chatId: chat._id,
                         chat: updatedChat
                     });
                     
                     logger.info(`Auto-transferred chat ${chat._id} from ${oldStaffId} to ${leastLoaded.staffId}`);
                 } catch (e) {
                     logger.warn('Socket emit failed for auto-transferred chat:', e.message);
                 }
            } else {
                logger.warn(`No other staff available to take chat ${chat._id}`);
            }
        }
    } catch (error) {
        logger.error('Error in checkAndTransferNewChats:', error);
    }
}

async function checkAndTransferInactiveChats() {
    try {
        const thresholdMinutes = 60;
        const threshold = new Date();
        threshold.setMinutes(threshold.getMinutes() - thresholdMinutes);

        // Find open chats assigned where the LAST message was from customer 
        // and it was > 60 mins ago, and no staff reply after that.
        const chatsToTransfer = await Chat.find({
            status: 'open',
            assignedTo: { $ne: null },
            lastCustomerMessageAt: { $lt: threshold },
            $or: [
                { lastStaffMessageAt: null },
                { $expr: { $gt: ["$lastCustomerMessageAt", "$lastStaffMessageAt"] } }
            ]
        });

        if (chatsToTransfer.length === 0) return;

        logger.info(`Found ${chatsToTransfer.length} inactive chats to reassign.`);

        for (const chat of chatsToTransfer) {
            if (await isMonthly({ chat })) {
                logger.info(`Chat ${chat._id} has monthly tag. Skipping auto-transfer.`);
                continue;
            }
            const oldStaffId = chat.assignedTo;

            // Reassign to other available staff (round-robin)
            const staffMembers = await User.find({
                _id: { $ne: oldStaffId },
                isActive: true,
                role: 'staff',
                assignedWabaId: chat.wabaId,
            }).select('_id').lean();

            if (staffMembers.length > 0) {
                const chatCounts = await Promise.all(
                    staffMembers.map(async (staff) => {
                        const count = await Chat.countDocuments({
                            assignedTo: staff._id,
                            status: { $ne: 'closed' },
                        });
                        return { staffId: staff._id, count };
                    })
                );

                chatCounts.sort((a, b) => a.count - b.count);
                const leastLoaded = chatCounts[0];

                 chat.assignedTo = leastLoaded.staffId;
                 await chat.save();
 
                 await ChatActivity.create({
                     chatId: chat._id,
                     type: 'auto_transferred',
                     details: {
                         fromStaffId: oldStaffId,
                         toStaffId: leastLoaded.staffId,
                         reason: 'staff_no_response_60m'
                     },
                 });
 
                 // Create escalation notification
                 try {
                     const notificationService = require('./notification.service');
                     const chatWithContact = await Chat.findById(chat._id).populate('contactId');
                     const customerName = chatWithContact?.contactId?.name || chatWithContact?.contactId?.nameOnWhatsApp || chat.phoneNumber || 'customer';
 
                     await notificationService.createNotification({
                         recipientId: leastLoaded.staffId,
                         type: 'escalation',
                         title: 'Escalation Alert',
                         body: `Chat with ${customerName} has been escalated to you`,
                         metadata: { chatId: chat._id.toString() }
                     });
                 } catch (notifErr) {
                     logger.error(`Failed to create escalation notification: ${notifErr.message}`);
                 }
 
                 try {
                     const io = getIO();
                     const updatedChat = await Chat.findById(chat._id)
                         .populate('assignedTo', 'name phone')
                         .populate('contactId', 'name nameOnWhatsApp profilePicture');
 
                     io.emit('chat:update', { chatId: chat._id, chat: updatedChat });
                 } catch (e) {
                     logger.warn('Socket emit failed for 60m transfer:', e.message);
                 }
            }
        }
    } catch (error) {
        logger.error('Error in checkAndTransferInactiveChats:', error);
    }
}

async function checkAndNudgeUnreadChats() {
    try {
        const nudgeMinutes = 3;
        const threshold = new Date();
        threshold.setMinutes(threshold.getMinutes() - nudgeMinutes);

        // Find chats that are unread, NOT in DND, and haven't been notified for > 3m
        // and the last message is from the CUSTOMER.
        const unreadChats = await Chat.find({
            status: 'open',
            isUnread: true,
            isDnd: { $ne: true },
            $or: [
                { lastNotificationAt: { $lt: threshold } },
                { lastNotificationAt: null, lastCustomerMessageAt: { $lt: threshold } }
            ],
            $expr: { 
                $or: [
                    { $gt: ["$lastCustomerMessageAt", "$lastStaffMessageAt"] },
                    { $eq: ["$lastStaffMessageAt", null] }
                ]
            }
        }).populate('contactId', 'name nameOnWhatsApp');

        if (unreadChats.length === 0) return;

        logger.info(`Found ${unreadChats.length} unread chats to nudge.`);

        const pushService = require('./push.service');
        const { Message: MessageModel } = require('../models');

        for (const chat of unreadChats) {
            // Get the last customer message content to repeat it
            const lastMsg = await MessageModel.findOne({ 
                chatId: chat._id, 
                direction: 'inbound' 
            }).sort({ createdAt: -1 });

            if (!lastMsg) continue;

            let userIdsToNotify = [];
            if (chat.assignedTo) {
                userIdsToNotify.push(chat.assignedTo.toString());
            } else {
                const admins = await User.find({
                    isActive: true,
                    role: { $in: ['admin', 'superadmin'] }
                }).select('_id').lean();
                userIdsToNotify = admins.map(u => u._id.toString());
            }

            if (userIdsToNotify.length > 0) {
                const profileName = chat.contactId?.name || chat.contactId?.nameOnWhatsApp || chat.waId;
                const notificationService = require('./notification.service');
                
                const isRepeated = !!chat.lastNotificationAt;
                const notifType = isRepeated ? 'repeated_notification' : 'unread_reminder';
                const title = isRepeated ? 'Repeated Notification' : 'Unread Reminder';
                const body = isRepeated 
                    ? `Nudge: Chat with ${profileName} is still unread`
                    : `You have unread messages from ${profileName}`;

                await notificationService.notifyMultipleUsers(userIdsToNotify, {
                    type: notifType,
                    title,
                    body,
                    metadata: { chatId: chat._id.toString() }
                });

                chat.lastNotificationAt = new Date();
                await chat.save();
            }
        }
    } catch (error) {
        logger.error('Error in checkAndNudgeUnreadChats:', error);
    }
}

module.exports = {
    checkAndCloseExpiredChats,
    checkAndTransferNewChats,
    checkAndTransferInactiveChats,
    checkAndNudgeUnreadChats
};
