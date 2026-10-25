const mongoose = require('./src/config/database');
const Broadcast = require('./src/models/Broadcast');

async function checkBroadcasts() {
  const broadcasts = await Broadcast.find({}, { _id: 1, name: 1, status: 1, isPaused: 1, pausedAt: 1, statistics: 1 }).sort({ createdAt: -1 }).limit(5);
  
  broadcasts.forEach(b => {
    console.log(`ID: ${b._id}`);
    console.log(`Name: ${b.name}`);
    console.log(`Status: ${b.status}`);
    console.log(`Paused: ${b.isPaused} at ${b.pausedAt || 'N/A'}`);
    console.log(`Stats: ${JSON.stringify(b.statistics, null, 2)}`);
    console.log('---');
  });
  
  process.exit(0);
}

checkBroadcasts().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
