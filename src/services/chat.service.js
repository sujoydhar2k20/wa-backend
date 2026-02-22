const { Chat, ChatActivity } = require('../models');
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

module.exports = {
    checkAndCloseExpiredChats
};
