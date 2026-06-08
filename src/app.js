const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const routes = require('./routes');
const { errorHandler } = require('./middleware/errorHandler.middleware');
const { requestLogger } = require('./utils/logger');

const path = require('path');
const config = require('./config');

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
// Serve uploaded media from VPS
app.use('/uploads', express.static(path.join(process.cwd(), config.upload.dir || 'uploads')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10000, // Increased from 200 to 10000 to prevent webhook / active staff rate-limiting issues
  message: { success: false, message: 'Too many requests' },
});
app.use('/api', limiter);
app.use(requestLogger);

app.use('/api', routes);

app.use((req, res) => res.status(404).json({ success: false, message: 'Not found' }));
app.use(errorHandler);

module.exports = app;
