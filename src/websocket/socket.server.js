const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { logger } = require('../utils/logger');
const config = require('../config');
const User = require('../models/User');

let io;

// userId -> Set of connected socket ids (used for "online staff" call routing)
const onlineUsers = new Map();

function initSocket(server) {
  // Configure CORS properly for credentials
  const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map(origin => origin.trim());

  io = new Server(server, {
    cors: {
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
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    },
    path: '/socket.io',
  });

  // Authenticate every socket with the same JWT used by the REST API.
  // The user id is taken from the verified token, never from client-supplied data.
  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth || {};
      const header = socket.handshake.headers?.authorization;
      const raw = auth.token || auth.Authorization || header || '';
      const token = String(raw).startsWith('Bearer ') ? String(raw).slice(7) : String(raw);
      if (!token) return next(new Error('Unauthorized'));

      const decoded = jwt.verify(token, config.jwt.secret);
      const user = await User.findById(decoded.userId).select('_id role isActive');
      if (!user || !user.isActive) return next(new Error('Unauthorized'));

      socket.userId = String(user._id);
      socket.userRole = user.role;
      next();
    } catch (err) {
      logger.warn(`Socket auth rejected: ${err.message}`);
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    socket.join(`user:${userId}`);

    const sockets = onlineUsers.get(userId) || new Set();
    sockets.add(socket.id);
    onlineUsers.set(userId, sockets);
    socket.to('staff').emit('user:online', { userId });

    socket.on('disconnect', () => {
      const set = onlineUsers.get(userId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) onlineUsers.delete(userId);
      }
      socket.to('staff').emit('user:offline', { userId });
    });
  });

  logger.info('Socket.io initialized');
  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

function isUserOnline(userId) {
  return onlineUsers.has(String(userId));
}

function getOnlineUserIds() {
  return Array.from(onlineUsers.keys());
}

module.exports = { initSocket, getIO, isUserOnline, getOnlineUserIds };
