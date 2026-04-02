module.exports = function (agenda) {
  agenda.define('send-broadcast-message', async (job) => {
    const { broadcastId, phoneNumber, contactId } = job.attrs.data;
    const broadcastService = require('../services/broadcast.service');
    await broadcastService.sendSingleBroadcastMessage(broadcastId, phoneNumber, contactId);
  });

  agenda.define('process-broadcast-queue', async (job) => {
    const { broadcastId } = job.attrs.data;
    const broadcastService = require('../services/broadcast.service');
    await broadcastService.processBroadcastQueue(broadcastId);
  });

  // Process a scheduled broadcast batch (for rate-limited multi-day broadcasts)
  agenda.define('process-broadcast-batch', async (job) => {
    const { batchId } = job.attrs.data;
    const broadcastService = require('../services/broadcast.service');
    await broadcastService.processBroadcastBatch(batchId);
  });
};
