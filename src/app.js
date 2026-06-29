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
app.use(express.json({ limit: '50mb' }));
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

// DIAGNOSTIC ENDPOINT: Check quoted messages in database (remove in production)
app.get('/api/diagnostic/quoted-messages', async (req, res) => {
    try {
        const { Message } = require('./models');
        const messages = await Message.find({ quotedMessage: { $exists: true, $ne: null } })
            .limit(20)
            .sort({ createdAt: -1 })
            .select('_id messageId type text quotedMessage replyToMessageId createdAt');
        
        const result = messages.map(m => ({
            _id: m._id,
            messageId: m.messageId,
            type: m.type,
            text: m.text?.substring(0, 50),
            quotedMessage: m.quotedMessage,
            replyToMessageId: m.replyToMessageId,
            createdAt: m.createdAt
        }));
        
        res.json({ 
            success: true, 
            count: result.length, 
            messages: result,
            total: await Message.countDocuments({ quotedMessage: { $exists: true, $ne: null } })
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.use('/api', routes);

app.use((req, res) => res.status(404).json({ success: false, message: 'Not found' }));
app.use(errorHandler);

module.exports = app;
