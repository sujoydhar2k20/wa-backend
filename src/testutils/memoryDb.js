'use strict';
/**
 * Test-only helper: a throwaway in-memory MongoDB (mongodb-memory-server) for integration tests of the
 * webhook pipeline. Never used by the running server.
 */
const mongoose = require('mongoose');

let server;

async function start() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  server = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  await mongoose.connect(server.getUri(), { dbName: 'test' });
  // Build indexes (unique message ids etc.) like production.
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes().catch(() => {})));
}

async function stop() {
  await mongoose.disconnect();
  if (server) await server.stop();
}

async function clear() {
  const cols = await mongoose.connection.db.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
}

/** Socket.io stand-in that records emitted events. */
function fakeIO() {
  const events = [];
  const io = {
    events,
    emit: (event, payload) => { events.push({ event, payload }); },
    to: (room) => ({ emit: (event, payload) => events.push({ room, event, payload }) }),
  };
  return io;
}

module.exports = { start, stop, clear, fakeIO };
