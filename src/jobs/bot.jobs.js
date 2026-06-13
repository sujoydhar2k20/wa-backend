module.exports = function (agenda) {
  // Resumes a bot flow that was paused on a time_delay node once the delay elapses.
  agenda.define('resume-bot-flow', async (job) => {
    const botService = require('../services/bot.service');
    const { executionId } = job.attrs.data || {};
    if (!executionId) return;
    await botService.resumeDelayedFlow(executionId);
  });
};
