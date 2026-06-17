require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/config/database');
const BotExecution = require('./src/models/BotExecution');

async function run() {
    await connectDB();
    const chatId = '6a035e0c7e871a5eeb9ed74b';
    console.log(`Searching executions for chat: ${chatId}`);
    const executions = await BotExecution.find({ chatId }).sort({ createdAt: -1 });
    console.log(`Found ${executions.length} executions:`);
    for (const e of executions) {
        console.log(`- Exec ID: ${e._id}, Flow ID: ${e.flowId}, Status: ${e.status}, Started: ${e.startedAt}`);
        console.log(`  Log:`, JSON.stringify(e.executionLog, null, 2));
    }
    await mongoose.disconnect();
}

run().catch(console.error);
