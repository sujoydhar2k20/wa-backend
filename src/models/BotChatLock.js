const mongoose = require('mongoose');

/**
 * Short-lived per-chat lock for the bot (one document per chat while a bot decision runs).
 * _id is the chat id; lockedUntil makes a lock left by a crashed process expire by itself.
 */
const botChatLockSchema = new mongoose.Schema(
  {
    _id: { type: mongoose.Schema.Types.ObjectId },
    lockedUntil: { type: Date, required: true },
    token: { type: String, required: true },
  },
  { versionKey: false }
);

// Clean up leftover lock documents an hour after they expired.
botChatLockSchema.index({ lockedUntil: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model('BotChatLock', botChatLockSchema);
