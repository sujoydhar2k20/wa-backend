const { logger } = require('../utils/logger');

module.exports = (agenda) => {
  // Delete call logs and recordings older than CALL_RETENTION_DAYS (default 365)
  agenda.define('cleanup-old-calls', async () => {
    try {
      await require('../services/calls/recordings').cleanupOld();
    } catch (e) {
      logger.error(`[calls] cleanup job failed: ${e.message}`);
    }
  });
};
