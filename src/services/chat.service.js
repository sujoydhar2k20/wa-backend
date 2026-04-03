const { Chat, ChatActivity, User } = require('../models');
const { getIO } = require('../websocket/socket.server');
const { logger } = require('../utils/logger');

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

module.exports = {
    checkAndCloseExpiredChats,
    checkAndTransferNewChats
};
