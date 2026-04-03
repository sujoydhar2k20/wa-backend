module.exports = function (agenda) {
  agenda.define('auto-close-expired-chats', async () => {
    const chatService = require('../services/chat.service');
    await chatService.checkAndCloseExpiredChats();
  });

  agenda.define('auto-transfer-inactive-new-chats', async () => {
    const chatService = require('../services/chat.service');
    await chatService.checkAndTransferNewChats();
  });

  agenda.every('*/5 * * * *', 'auto-close-expired-chats'); // every 5 minutes
  agenda.every('1 minute', 'auto-transfer-inactive-new-chats'); // every 1 minute
};
