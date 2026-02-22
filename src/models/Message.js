const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  latitude: Number,
  longitude: Number,
  name: String,
  address: String,
}, { _id: false });

const reactionSchema = new mongoose.Schema({
  messageId: String,
  emoji: String,
}, { _id: false });

const messageSchema = new mongoose.Schema(
  {
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
    wabaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Waba', index: true },
    phoneNumberId: { type: String },
    messageId: { type: String, index: true },
    waId: { type: String },
    direction: { type: String, enum: ['inbound', 'outbound', 'internal'], required: true },
    type: { type: String, enum: ['text', 'image', 'video', 'audio', 'document', 'location', 'sticker', 'reaction', 'note', 'system'], default: 'text' },
    text: { type: String },
    mediaUrl: { type: String },
    mediaId: { type: String },
    mimeType: { type: String },
    fileName: { type: String },
    fileSize: { type: Number },
    caption: { type: String },
    location: locationSchema,
    reactions: [{
      emoji: String,
      by: String // waId or Staff ID representing who reacted
    }],
    status: { type: String, enum: ['sent', 'delivered', 'read', 'failed'] },
    statusTimestamp: { type: Date },
    errorCode: { type: Number },
    errorMessage: { type: String },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

messageSchema.index({ chatId: 1, createdAt: -1 });
module.exports = mongoose.model('Message', messageSchema);
