module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  apiUrl: process.env.API_URL || 'http://localhost:3000',
  jwt: {
    // No fallback: a missing/weak secret must stop the server, never silently use a known value.
    secret: process.env.JWT_SECRET,
    expiry: process.env.JWT_EXPIRY || '365d',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '365d',
  },
  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 52428800, // Default 50MB
    dir: process.env.UPLOAD_DIR || './uploads',
  },
  meta: {
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN,
    apiVersion: 'v25.0',
  },
};

// Fail fast on missing security-critical configuration.
if (!module.exports.jwt.secret || module.exports.jwt.secret.length < 32) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters');
}
if (!module.exports.meta.appSecret) {
  // Webhook signature verification fails closed without this; refuse to run half-configured in production.
  if (module.exports.nodeEnv === 'production') {
    throw new Error('META_APP_SECRET must be set (required to verify Meta webhook signatures)');
  }
  console.warn('[config] META_APP_SECRET is not set: all inbound Meta webhooks will be rejected');
}
