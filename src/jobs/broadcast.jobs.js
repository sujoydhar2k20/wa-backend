module.exports = function (agenda) {
  agenda.define('send-broadcast-message', async (job) => {
    const { broadcastId, phoneNumber, contactId } = job.attrs.data;
    // Implemented in broadcast.service
    const broadcastService = require('../services/broadcast.service');
    await broadcastService.sendSingleBroadcastMessage(broadcastId, phoneNumber, contactId);
  });

  agenda.define('process-broadcast-queue', async (job) => {
    const { broadcastId } = job.attrs.data;
    const broadcastService = require('../services/broadcast.service');
    await broadcastService.processBroadcastQueue(broadcastId);
  });
};
