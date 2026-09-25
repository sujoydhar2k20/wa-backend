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

// Configure CORS properly for credentials
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map(origin => origin.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  next();
});
// Serve uploaded media from VPS
app.use('/uploads', express.static(path.join(process.cwd(), config.upload.dir || 'uploads')));
app.use(express.json({
  limit: '50mb',
  // Keep the exact bytes of webhook bodies: Meta's X-Hub-Signature-256 is computed over the raw
  // payload, so it cannot be verified from the re-serialised JSON.
  verify: (req, res, buf) => {
    const url = req.originalUrl || req.url || '';
    if (url.includes('/webhook')) req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Global rate limiter: 50,000 requests per 15 minutes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50000, // Global limit: 50,000 req/15 min (~55 req/sec)
  message: { success: false, message: 'Too many requests' },
  skip: (req) => {
    // Skip rate limiting for webhook endpoints
    return req.path === '/api/webhook' || req.path.startsWith('/api/webhook/');
  },
  keyGenerator: (req, res) => {
    // Rate limit per user ID if authenticated, otherwise by IP
    return req.user?._id?.toString() || req.ip;
  },
});

// Per-user rate limiter: 500 requests per 15 minutes per authenticated user
const perUserLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500, // Per-user limit: 500 req/15 min (~5.5 req/sec per user)
  message: { success: false, message: 'Too many requests from this user' },
  skip: (req) => {
    // Only apply to authenticated users
    return !req.user || !req.user._id;
  },
  keyGenerator: (req, res) => {
    return req.user._id.toString();
  },
});

app.use('/api', limiter);
app.use('/api', perUserLimiter);
app.use(requestLogger);

app.use('/api', routes);

app.use((req, res) => res.status(404).json({ success: false, message: 'Not found' }));
app.use(errorHandler);

module.exports = app;
