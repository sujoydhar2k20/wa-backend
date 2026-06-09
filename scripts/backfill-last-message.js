/**
 * One-time backfill script: populate lastMessageText, lastMessageDirection,
 * and lastMessageStatus for all existing Chat documents.
 *
 * Usage:
 *   node backend/scripts/backfill-last-message.js
 *
 * Run from the project root or the backend directory.
 * Uses the same MONGODB_URI from your .env file.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-system';

// ---- Inline schema definitions (mirrors the real models) ----

const chatSchema = new mongoose.Schema(
  {
    lastMessageText: { type: String },
    lastMessageDirection: { type: String },
    lastMessageStatus: { type: String },
  },
  { strict: false, timestamps: true }
);
const Chat = mongoose.model('Chat', chatSchema);

const messageSchema = new mongoose.Schema(
  {
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat' },
    direction: { type: String },
    type: { type: String },
    text: { type: String },
    caption: { type: String },
    fileName: { type: String },
    status: { type: String },
  },
  { strict: false, timestamps: true }
);
const Message = mongoose.model('Message', messageSchema);

// ---- Helper: build snippet text from message ----
function buildSnippet(msg) {
  switch (msg.type) {
    case 'text': return msg.text || '';
    case 'image': return msg.caption || '📷 Photo';
    case 'video': return msg.caption || '🎥 Video';
    case 'audio': return '🎙️ Voice Message';
    case 'document': return msg.fileName ? `📄 ${msg.fileName}` : '📄 Document';
    case 'location': return '📍 Location';
    case 'sticker': return '🖼️ Sticker';
    case 'note': return `📝 Note: ${msg.text || ''}`;
    case 'system': return msg.text || '';
    case 'template': return msg.text || '📄 Template Message';
    case 'interactive': return msg.text || '🔘 Interactive Message';
    default: return msg.text || '';
  }
}

async function run() {
  console.log(`Connecting to MongoDB: ${MONGODB_URI.replace(/\/\/[^@]+@/, '//***@')} ...`);
  await mongoose.connect(MONGODB_URI);
  console.log('Connected.\n');

  // Get all chat IDs
  const chatIds = await Chat.distinct('_id');
  const total = chatIds.length;
  console.log(`Found ${total} chats to backfill.\n`);

  let updated = 0;
  let skipped = 0;

  // Process in batches of 100 for efficiency
  const BATCH_SIZE = 100;
  for (let i = 0; i < chatIds.length; i += BATCH_SIZE) {
    const batch = chatIds.slice(i, i + BATCH_SIZE);

    // For each chat, find the latest non-reaction message
    const latestMessages = await Message.aggregate([
      { $match: { chatId: { $in: batch }, type: { $ne: 'reaction' } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$chatId',
          type: { $first: '$type' },
          text: { $first: '$text' },
          caption: { $first: '$caption' },
          fileName: { $first: '$fileName' },
          direction: { $first: '$direction' },
          status: { $first: '$status' },
          createdAt: { $first: '$createdAt' },
        },
      },
    ]);

    const bulkOps = latestMessages.map((msg) => ({
      updateOne: {
        filter: { _id: msg._id },
        update: {
          $set: {
            lastMessageText: buildSnippet(msg),
            lastMessageDirection: msg.direction,
            lastMessageStatus: msg.status,
            lastMessageAt: msg.createdAt,
          },
        },
      },
    }));

    if (bulkOps.length > 0) {
      await Chat.bulkWrite(bulkOps);
      updated += bulkOps.length;
    }

    // Chats in this batch with no messages at all
    skipped += batch.length - bulkOps.length;

    const progress = Math.min(i + BATCH_SIZE, total);
    process.stdout.write(`  Progress: ${progress}/${total} chats processed...\r`);
  }

  console.log(`\n\nDone!`);
  console.log(`  ✅  Updated : ${updated} chats with last message data`);
  console.log(`  ⏭️   Skipped : ${skipped} chats (no messages found)\n`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('\nBackfill failed:', err);
  process.exit(1);
});
