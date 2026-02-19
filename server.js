require('dotenv').config();
const http = require('http');
const app = require('./src/app');
const { connectDB } = require('./src/config/database');
const { initSocket } = require('./src/websocket/socket.server');
const { initAgenda } = require('./src/jobs/agenda');

const PORT = process.env.PORT || 3000;

async function start() {
  await connectDB();
  const server = http.createServer(app);
  initSocket(server);
  await initAgenda();

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
