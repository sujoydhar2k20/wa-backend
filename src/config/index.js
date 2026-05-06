module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  apiUrl: process.env.API_URL || 'http://localhost:3000',
  superAdminPhone: process.env.SUPER_ADMIN_PHONE || '03154239421',
  sendOtp: process.env.SEND_OTP !== 'false',
  jwt: {
    secret: process.env.JWT_SECRET || 'jwt-secret',
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
