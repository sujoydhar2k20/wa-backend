const logger = require('../utils/logger').logger;

function errorHandler(err, req, res, next) {
  logger.error({ err: err.message, stack: err.stack });
  const status = err.statusCode || err.status || 500;
  const message = err.message || 'Internal server error';
  res.status(status).json({ success: false, message });
}

module.exports = { errorHandler };
