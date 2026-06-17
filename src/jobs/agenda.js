const Agenda = require('agenda');
const { logger } = require('../utils/logger');

let agenda;

async function initAgenda() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-system';
  agenda = new Agenda({ db: { address: mongoUri, collection: 'agendaJobs' } });

  agenda.on('error', (err) => logger.error('Agenda error', err));

  // Wait for Agenda database connection to be ready
  await new Promise((resolve) => {
    agenda.once('ready', resolve);
  });

  logger.info('Agenda ready');

  // Clear stale locks on startup to prevent stuck jobs
  try {
    if (agenda._collection) {
      // Only unlock jobs that have been locked for more than 1 hour.
      // This is extremely safe in multi-instance/cluster environments.
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const res = await agenda._collection.updateMany(
        { lockedAt: { $ne: null, $lt: oneHourAgo } },
        { $set: { lockedAt: null } }
      );
      if (res.modifiedCount > 0) {
        logger.info(`Cleared ${res.modifiedCount} stale Agenda locks (older than 1 hour)`);
      }
    }
  } catch (err) {
    logger.error('Failed to clear stale Agenda locks:', err.message);
  }

  // 1. Define all jobs first (safe to call agenda.every/define now)
  require('./broadcast.jobs')(agenda);
  require('./chat.jobs')(agenda);
  require('./product.jobs')(agenda);
  require('./template.jobs')(agenda);
  require('./bulkSend.jobs')(agenda);
  require('./mediaCleanup.jobs')(agenda);
  require('./bot.jobs')(agenda);

  // 2. Start agenda processing queue
  await agenda.start();

  // 3. Schedule recurring/interval jobs
  await agenda.every('24 hours', 'cleanup-expired-media');

  return agenda;
}

function getAgenda() {
  return agenda;
}

module.exports = { initAgenda, getAgenda };
