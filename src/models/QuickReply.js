const mongoose = require('mongoose');

const quickReplySchema = new mongoose.Schema(
  {
    shortcut: { type: String, required: true, index: true },
    message: { type: String, required: true },
    mediaUrl: { type: String },
    mediaType: { type: String, enum: ['image', 'video', 'audio', 'document'] },
    visibility: { type: String, enum: ['everyone', 'me'], default: 'everyone', index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    wabaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Waba', index: true },
  },
  { timestamps: true }
);

// Ensure shortcut is unique per WABA/User scope
// Since we don't have a formal Org/Tenant model, we'll use WabaId or just global if WabaId is null
quickReplySchema.index({ shortcut: 1, wabaId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('QuickReply', quickReplySchema);
