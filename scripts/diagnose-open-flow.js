/**
 * Diagnostic for the "on_open_conversation" bot flow.
 *
 * Usage (from the backend/ folder, with the same env as the server):
 *   node scripts/diagnose-open-flow.js [waId]
 *
 * Example:
 *   node scripts/diagnose-open-flow.js 917278665321
 *
 * It prints:
 *   - every BotFlow, its trigger type, isEnabled, cooldownMinutes, node types
 *   - which flows would match on_open_conversation
 *   - the chat for the given waId (status, tags)
 *   - recent BotExecutions for that chat (to reveal cooldown blocking)
 */

require('dotenv').config();
const mongoose = require('mongoose');

// Load models via the project's model index so schemas register correctly.
const path = require('path');
const models = require(path.join(__dirname, '..', 'src', 'models'));
const { BotFlow, BotExecution, Chat, Tag } = models;

const waId = process.argv[2] || null;

async function main() {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-system';
    console.log(`\nConnecting to: ${uri}\n`);
    await mongoose.connect(uri);

    // 1) All flows overview
    const flows = await BotFlow.find().lean();
    console.log(`=== BotFlows (${flows.length} total) ===`);
    for (const f of flows) {
        const triggerType = f.trigger?.type || '(none)';
        const nodeTypes = (f.nodes || []).map(n => n.type).join(', ') || '(no nodes)';
        console.log(
            `- "${f.name}" | id=${f._id}\n` +
            `    isEnabled=${f.isEnabled} | trigger.type=${triggerType} | cooldownMinutes=${f.cooldownMinutes ?? 0}\n` +
            `    nodes: ${nodeTypes}`
        );
    }

    // 2) Flows that the open-conversation handler would pick up
    const openFlows = await BotFlow.find({ isEnabled: true, 'trigger.type': 'on_open_conversation' }).lean();
    console.log(`\n=== Enabled on_open_conversation flows: ${openFlows.length} ===`);
    if (openFlows.length === 0) {
        console.log('  >>> NONE. This is why nothing fires on open/reopen.');
        console.log('      Either the flow is not enabled, or its trigger node is not set to "On Open Conversation".');
    } else {
        for (const f of openFlows) {
            console.log(`  - "${f.name}" (cooldownMinutes=${f.cooldownMinutes ?? 0})`);
        }
    }

    // 3) Chat + recent executions for the given waId
    if (waId) {
        const chat = await Chat.findOne({ waId }).lean();
        console.log(`\n=== Chat for waId ${waId} ===`);
        if (!chat) {
            console.log('  No chat found for this waId.');
        } else {
            // Resolve tag names
            let tagNames = [];
            if (chat.tags && chat.tags.length) {
                const tags = await Tag.find({ _id: { $in: chat.tags } }).select('name').lean();
                tagNames = tags.map(t => t.name);
            }
            console.log(`  chatId=${chat._id} | status=${chat.status} | tags=[${tagNames.join(', ')}]`);
            console.log(`  closedAt=${chat.closedAt || '(none)'} | lastCustomerMessageAt=${chat.lastCustomerMessageAt || '(none)'}`);

            const execs = await BotExecution.find({ chatId: chat._id })
                .sort({ startedAt: -1 })
                .limit(10)
                .populate('flowId', 'name trigger')
                .lean();
            console.log(`\n=== Last ${execs.length} BotExecutions for this chat ===`);
            for (const e of execs) {
                const fname = e.flowId?.name || '(deleted flow)';
                const ftype = e.flowId?.trigger?.type || '?';
                console.log(
                    `  - flow="${fname}" (${ftype}) | status=${e.status} | startedAt=${e.startedAt}` +
                    ` | nodes run: ${(e.executionLog || []).map(l => l.action).join(' > ') || '(none)'}`
                );
            }
            if (execs.length === 0) {
                console.log('  (no executions ever recorded for this chat)');
            }
        }
    } else {
        console.log('\n(Tip: pass a waId to inspect a specific chat, e.g. `node scripts/diagnose-open-flow.js 917278665321`)');
    }

    await mongoose.disconnect();
    console.log('\nDone.\n');
}

main().catch(err => {
    console.error('Diagnostic failed:', err);
    process.exit(1);
});
