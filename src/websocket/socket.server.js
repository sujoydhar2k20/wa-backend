const { Server } = require('socket.io');
const { logger } = require('../utils/logger');

let io;

function initSocket(server) {
  io = new Server(server, {
    cors: { origin: process.env.CORS_ORIGIN || '*', credentials: true },
    path: '/socket.io',
  });

  io.on('connection', (socket) => {
    const userId = socket.handshake.auth?.userId;
    if (userId) {
      socket.join(`user:${userId}`);
      socket.userId = userId;
      socket.to('staff').emit('user:online', { userId });
    }
    socket.on('disconnect', () => {
      if (socket.userId) socket.to('staff').emit('user:offline', { userId: socket.userId });
    });
  });

  logger.info('Socket.io initialized');
  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

module.exports = { initSocket, getIO };
