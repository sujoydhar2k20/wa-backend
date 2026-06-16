/**
 * Find duplicate Contact documents (same phone number stored more than once).
 *
 * waId is indexed but NOT unique, so the same number can have multiple Contact docs.
 * This causes inconsistent block/opt-out behaviour: one copy gets blocked (and shows
 * "Blocked" in the UI) while the webhook may load another, un-blocked copy.
 *
 * Usage (from backend/, same env as the server):
 *   node scripts/find-duplicate-contacts.js [waId]
 *
 * Read-only — it does not modify anything.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const { Contact } = require(path.join(__dirname, '..', 'src', 'models'));

const onlyWaId = process.argv[2] ? String(process.argv[2]).replace(/\D/g, '') : null;

async function main() {
    const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/whatsapp-system';
    console.log(`\nConnecting to: ${uri}\n`);
    await mongoose.connect(uri);

    const contacts = await Contact.find().select('waId phoneNumber name isBlocked isOptedOut createdAt').lean();

    // Group by digits-only number (waId, falling back to phoneNumber).
    const groups = new Map();
    for (const c of contacts) {
        const key = String(c.waId || c.phoneNumber || '').replace(/\D/g, '');
        if (!key) continue;
        if (onlyWaId && key !== onlyWaId && !key.endsWith(onlyWaId) && !onlyWaId.endsWith(key)) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
    }

    const dupes = [...groups.entries()].filter(([, arr]) => arr.length > 1);
    console.log(`Total contacts: ${contacts.length}`);
    console.log(`Numbers with duplicates: ${dupes.length}\n`);

    for (const [key, arr] of dupes) {
        const anyBlocked = arr.some(c => c.isBlocked);
        const allBlocked = arr.every(c => c.isBlocked);
        const flag = anyBlocked && !allBlocked ? '  <-- INCONSISTENT BLOCK STATE' : '';
        console.log(`Number ${key} — ${arr.length} copies${flag}`);
        for (const c of arr) {
            console.log(
                `   _id=${c._id} | name="${c.name || ''}" | waId=${c.waId || '-'} | phone=${c.phoneNumber || '-'}` +
                ` | isBlocked=${!!c.isBlocked} | isOptedOut=${!!c.isOptedOut} | created=${c.createdAt}`
            );
        }
        console.log('');
    }

    if (dupes.length === 0) {
        console.log('No duplicates found — the block issue is not caused by duplicate contacts.');
    }

    await mongoose.disconnect();
    console.log('Done.\n');
}

main().catch(err => {
    console.error('Diagnostic failed:', err);
    process.exit(1);
});
