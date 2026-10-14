/**
 * One-time index migration for customers known only by a WhatsApp username / business-scoped user ID.
 *
 * Before: chats had a unique index { wabaId: 1, waId: 1 } that also covers chats WITHOUT a phone number,
 * so a second phone-less (BSUID-only) chat on the same business number would be rejected.
 * After:  two PARTIAL unique indexes — { wabaId, waId } only where waId is a string, and
 *         { wabaId, bsuid } only where bsuid is a string. Same guarantee for phone chats, no collisions
 *         for phone-less chats.
 *
 * No documents are changed or deleted; only indexes.
 *
 *   node scripts/migrate-bsuid-indexes.js            # dry run: shows what it would do
 *   node scripts/migrate-bsuid-indexes.js --apply    # do it
 *
 * Safe to run more than once. Take a database backup first (mongodump) as with any production change.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const OLD_NAME = 'wabaId_1_waId_1';
const NEW_INDEXES = [
  { key: { wabaId: 1, waId: 1 }, options: { unique: true, name: 'wabaId_waId_unique_partial', partialFilterExpression: { waId: { $type: 'string' } } } },
  { key: { wabaId: 1, bsuid: 1 }, options: { unique: true, name: 'wabaId_bsuid_unique_partial', partialFilterExpression: { bsuid: { $type: 'string' } } } },
];

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/whatsapp-system';
  await mongoose.connect(uri);
  const { Chat } = require(path.join(__dirname, '..', 'src', 'models'));
  const col = Chat.collection;
  const existing = await col.indexes();
  const names = existing.map((i) => i.name);
  console.log(`\nMode: ${APPLY ? 'APPLY' : 'dry run (add --apply to make changes)'}`);
  console.log(`Chat indexes now: ${names.join(', ')}`);

  // Sanity: duplicates that would block the new unique indexes (should be none: the old index prevented them).
  const dupes = await col.aggregate([
    { $match: { waId: { $type: 'string' } } },
    { $group: { _id: { wabaId: '$wabaId', waId: '$waId' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 5 },
  ]).toArray();
  if (dupes.length) {
    console.log(`\nSTOP: ${dupes.length}+ duplicate chats per phone number exist; resolve them first. Nothing changed.`);
    await mongoose.disconnect();
    process.exit(2);
  }

  let oldDropped = false;
  for (const idx of NEW_INDEXES) {
    if (names.includes(idx.options.name)) { console.log(`  ok      ${idx.options.name} already exists`); continue; }
    console.log(`  create  ${idx.options.name}`);
    if (!APPLY) continue;
    try {
      await col.createIndex(idx.key, idx.options);
    } catch (e) {
      // Older MongoDB versions refuse a second index on the same keys: drop the old one first.
      if (![85, 86].includes(e.code) || !names.includes(OLD_NAME) || oldDropped) throw e;
      console.log(`  (MongoDB needs the old index removed first) drop ${OLD_NAME}, then create`);
      await col.dropIndex(OLD_NAME);
      oldDropped = true;
      await col.createIndex(idx.key, idx.options);
    }
  }
  // Drop the old index only after the replacement exists, so phone chats are never unprotected.
  if (oldDropped) {
    console.log(`  dropped ${OLD_NAME}`);
  } else if (names.includes(OLD_NAME)) {
    console.log(`  drop    ${OLD_NAME} (replaced by wabaId_waId_unique_partial)`);
    if (APPLY) await col.dropIndex(OLD_NAME);
  } else {
    console.log(`  ok      ${OLD_NAME} not present`);
  }

  if (APPLY) console.log(`\nChat indexes after: ${(await col.indexes()).map((i) => i.name).join(', ')}`);
  console.log(APPLY ? '\nDone.' : '\nDry run finished. Re-run with --apply.');
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('Migration failed:', e.message);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
