require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('./src/config/database');
const BotFlow = require('./src/models/BotFlow');
const BotExecution = require('./src/models/BotExecution');

async function run() {
    await connectDB();
    
    console.log('--- FETCHING BOT FLOW ---');
    const flow = await BotFlow.findOne({ name: /On open Conversation/i });
    if (!flow) {
        console.log('Flow "On open Conversation" not found!');
        const allFlows = await BotFlow.find({});
        console.log('All available flows in DB:', allFlows.map(f => f.name));
        await mongoose.disconnect();
        return;
    }
    
    console.log(`Flow Name: ${flow.name}`);
    console.log(`Flow ID: ${flow._id}`);
    console.log(`Is Enabled: ${flow.isEnabled}`);
    console.log('Nodes:');
    flow.nodes.forEach(n => {
        console.log(`  - [${n.id}] type: ${n.type}, config:`, JSON.stringify(n.config));
    });
    console.log('Edges:');
    flow.edges.forEach(e => {
        console.log(`  - ${e.source} -> ${e.target} (handle: ${e.sourceHandle})`);
    });

    console.log('\n--- FETCHING EXECUTIONS FOR CHAT 6a035e0c7e871a5eeb9ed74b ---');
    const executions = await BotExecution.find({ chatId: '6a035e0c7e871a5eeb9ed74b' }).sort({ createdAt: -1 });
    console.log(`Found ${executions.length} executions:`);
    executions.forEach(e => {
        console.log(`\nExecution ID: ${e._id}`);
        console.log(`Status: ${e.status}`);
        console.log(`Started At: ${e.startedAt}`);
        console.log(`Completed At: ${e.completedAt}`);
        console.log('Execution Logs:');
        e.executionLog.forEach(log => {
            console.log(`  - Node [${log.nodeId}] (${log.action}):`, JSON.stringify(log.result));
        });
    });

    await mongoose.disconnect();
}

run().catch(console.error);
