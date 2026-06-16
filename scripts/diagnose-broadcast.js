/**
 * Diagnose why a broadcast didn't send.
 *
 * Usage (from backend/, same env as the server):
 *   node scripts/diagnose-broadcast.js            # inspects the most recent broadcast
 *   node scripts/diagnose-broadcast.js <broadcastId>
 *
 * Read-only. Prints the broadcast config, its batches, and every recipient's
 * status + Meta errorCode/errorMessage so the real failure reason is visible.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const { Broadcast, BroadcastMessage, BroadcastBatch, Template } = require(path.join(__dirname, '..', 'src', 'models'));

async function main() {
    const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/whatsapp-system';
    console.log(`\nConnecting to: ${uri}\n`);
    await mongoose.connect(uri);

    const id = process.argv[2];
    const broadcast = id
        ? await Broadcast.findById(id).lean()
        : await Broadcast.findOne().sort({ createdAt: -1 }).lean();

    if (!broadcast) {
        console.log('No broadcast found.');
        await mongoose.disconnect();
        return;
    }

    const tpl = await Template.findById(broadcast.templateId).lean();

    console.log('=== Broadcast ===');
    console.log(`name="${broadcast.name}" | id=${broadcast._id}`);
    console.log(`status=${broadcast.status} | createdAt=${broadcast.createdAt}`);
    console.log(`wabaId=${broadcast.wabaId} | phoneNumberId=${broadcast.phoneNumberId || '(MISSING!)'}`);
    console.log(`template="${tpl?.name}" (${tpl?.language}) | status=${tpl?.status}`);
    console.log(`statistics=${JSON.stringify(broadcast.statistics)}`);
    console.log(`components (variables provided when sending):`);
    console.log(JSON.stringify(broadcast.components || [], null, 2));

    // Show how many {{n}} placeholders the template expects vs what was provided.
    if (tpl?.components) {
        for (const c of tpl.components) {
            if (c.text && (c.type === 'BODY' || c.type === 'HEADER')) {
                const matches = (c.text.match(/\{\{\d+\}\}/g) || []).length;
                console.log(`   template ${c.type} expects ${matches} variable(s)`);
            }
            if (c.type === 'BUTTONS' && Array.isArray(c.buttons)) {
                c.buttons.forEach((b, i) => {
                    if (b?.type === 'URL' && /\{\{\d+\}\}/.test(b.url || '')) {
                        console.log(`   template BUTTON[${i}] "${b.text}" has a dynamic URL variable`);
                    }
                });
            }
        }
    }

    console.log('\n=== Batches ===');
    const batches = await BroadcastBatch.find({ broadcastId: broadcast._id }).sort({ batchNumber: 1 }).lean();
    for (const b of batches) {
        console.log(`batch#${b.batchNumber} | status=${b.status} | members=${b.memberCount} | sent=${b.sentCount ?? 0} | failed=${b.failedCount ?? 0} | scheduledAt=${b.scheduledAt}`);
    }

    console.log('\n=== Recipient results (BroadcastMessage) ===');
    const msgs = await BroadcastMessage.find({ broadcastId: broadcast._id }).lean();
    if (msgs.length === 0) {
        console.log('  No recipient records at all — the batch never processed (Agenda not running? error before send?).');
    }
    const byStatus = {};
    for (const m of msgs) {
        byStatus[m.status] = (byStatus[m.status] || 0) + 1;
        console.log(`  ${m.phoneNumber} | status=${m.status} | errorCode=${m.errorCode ?? '-'} | error="${m.errorMessage || ''}"`);
    }
    console.log(`\nTotals by status: ${JSON.stringify(byStatus)}`);

    await mongoose.disconnect();
    console.log('\nDone.\n');
}

main().catch(err => {
    console.error('Diagnostic failed:', err);
    process.exit(1);
});
