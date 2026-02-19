module.exports = function (agenda) {
  agenda.define('import-products', async (job) => {
    const { importId } = job.attrs.data;
    const productService = require('../services/product.service');
    await productService.processImport(importId);
  });

  agenda.define('cleanup-old-media', async () => {
    const mediaService = require('../services/media.service');
    await mediaService.cleanupExpiredMedia();
  });

  agenda.every('0 2 * * *', 'cleanup-old-media'); // daily 2am
};
