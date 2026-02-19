module.exports = function (agenda) {
  agenda.define('sync-templates', async (job) => {
    const { wabaId } = job.attrs.data;
    const whatsappService = require('../services/whatsapp.service');
    await whatsappService.syncTemplates(wabaId);
  });
};
