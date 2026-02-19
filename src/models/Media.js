const mongoose = require('mongoose');

const mediaSchema = new mongoose.Schema(
  {
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', index: true },
    mediaId: { type: String },
    url: { type: String, required: true },
    type: { type: String, enum: ['image', 'video', 'audio', 'document'], required: true },
    mimeType: { type: String },
    fileName: { type: String },
    fileSize: { type: Number },
    expiresAt: { type: Date, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Media', mediaSchema);
