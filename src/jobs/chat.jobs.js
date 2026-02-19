module.exports = function (agenda) {
  agenda.define('auto-close-expired-chats', async () => {
    const chatService = require('../services/chat.service');
    await chatService.checkAndCloseExpiredChats();
  });

  agenda.every('0 * * * *', 'auto-close-expired-chats'); // every hour
};
