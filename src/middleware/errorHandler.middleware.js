const logger = require('../utils/logger').logger;

function errorHandler(err, req, res, next) {
  logger.error({ err: err.message, stack: err.stack });

  // Handle Multer size limit error
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      message: 'File too large. Maximum allowed size is 50MB.'
    });
  }

  const status = err.statusCode || err.status || 500;
  const message = err.message || 'Internal server error';
  res.status(status).json({ success: false, message });
}

module.exports = { errorHandler };
