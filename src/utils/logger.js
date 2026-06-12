const winston = require('winston');

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf((info) => {
    const { timestamp, level, message, ...metadata } = info;
    let msg = message;
    
    if (typeof msg === 'object') {
      try {
        msg = JSON.stringify(msg);
      } catch (err) {
        msg = String(msg);
      }
    }
    
    const stack = info.stack || metadata.err?.stack || metadata.error?.stack;
    
    delete metadata.service;
    delete metadata.stack;
    
    let metaStr = '';
    if (Object.keys(metadata).length > 0) {
      try {
        metaStr = ` ${JSON.stringify(metadata)}`;
      } catch (e) {}
    }
    
    const stackStr = stack ? `\n${stack}` : '';
    return `${timestamp} [${level}]: ${msg || ''}${metaStr}${stackStr}`;
  })
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'whatsapp-backend' },
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    logger.info(`${req.method} ${req.originalUrl} - ${res.statusCode} in ${Date.now() - start}ms`);
  });
  next();
}

module.exports = { logger, requestLogger };

