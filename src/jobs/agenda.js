const Agenda = require('agenda');
const { logger } = require('../utils/logger');

let agenda;

async function initAgenda() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-system';
  agenda = new Agenda({ db: { address: mongoUri, collection: 'agendaJobs' } });

  agenda.on('ready', () => logger.info('Agenda ready'));
  agenda.on('error', (err) => logger.error('Agenda error', err));

  await agenda.start();
  require('./broadcast.jobs')(agenda);
  require('./chat.jobs')(agenda);
  require('./product.jobs')(agenda);
  require('./template.jobs')(agenda);
  require('./bulkSend.jobs')(agenda);
  require('./mediaCleanup.jobs')(agenda);
  require('./bot.jobs')(agenda);

  // Schedule cleanup to run every 24 hours
  await agenda.every('24 hours', 'cleanup-expired-media');

  return agenda;
}

function getAgenda() {
  return agenda;
}

module.exports = { initAgenda, getAgenda };
