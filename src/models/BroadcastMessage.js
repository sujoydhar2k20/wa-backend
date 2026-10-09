const mongoose = require('mongoose');

const broadcastMessageSchema = new mongoose.Schema(
  {
    broadcastId: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', required: true, index: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
    phoneNumber: { type: String, required: true },
    messageId: { type: String },
    status: { type: String, enum: ['sent', 'delivered', 'read', 'failed', 'skipped'], default: 'sent' },
    reactions: [{ emoji: String, count: { type: Number, default: 1 } }],
    repliedAt: { type: Date },
    errorCode: { type: Number },
    errorMessage: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BroadcastMessage', broadcastMessageSchema);
