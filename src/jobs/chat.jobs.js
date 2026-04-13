module.exports = function (agenda) {
  agenda.define('auto-close-expired-chats', async () => {
    const chatService = require('../services/chat.service');
    await chatService.checkAndCloseExpiredChats();
  });

  agenda.define('auto-transfer-inactive-new-chats', async () => {
    const chatService = require('../services/chat.service');
    await chatService.checkAndTransferNewChats();
  });

  agenda.define('auto-transfer-inactive-chats', async () => {
    const chatService = require('../services/chat.service');
    await chatService.checkAndTransferInactiveChats();
  });

  agenda.define('nudge-pending-chats', async () => {
    const chatService = require('../services/chat.service');
    await chatService.checkAndNudgeUnreadChats();
  });

  agenda.every('*/5 * * * *', 'auto-close-expired-chats'); // every 5 minutes
  agenda.every('1 minute', 'auto-transfer-inactive-new-chats'); // every 1 minute
  agenda.every('5 minutes', 'auto-transfer-inactive-chats'); // check every 5 mins for the 60m threshold
  agenda.every('1 minute', 'nudge-pending-chats'); // check every minute for the 3m nudge
};
