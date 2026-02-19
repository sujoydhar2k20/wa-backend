const mongoose = require('mongoose');
const logger = require('../utils/logger').logger;

async function connectDB() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-system';
  await mongoose.connect(uri);
  logger.info('MongoDB connected');
}

module.exports = { connectDB };
