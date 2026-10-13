const mongoose = require('mongoose');

/**
 * One row per (chat, clientMessageId) sent through POST /messages/send.
 * Makes app retries idempotent: a retried request with the same clientMessageId returns the
 * message created by the first request instead of sending the WhatsApp message again.
 * Rows expire after 7 days.
 */
const sendRequestSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true },
    clientMessageId: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['pending', 'done'], default: 'pending' },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    claimedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

sendRequestSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

module.exports = mongoose.model('SendRequest', sendRequestSchema);
