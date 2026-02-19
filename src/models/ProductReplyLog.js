const mongoose = require('mongoose');

const productReplyLogSchema = new mongoose.Schema(
  {
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', index: true },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    productCode: { type: String, required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    status: { type: String, enum: ['success', 'error'], required: true },
    errorMessage: { type: String },
    repliedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

module.exports = mongoose.model('ProductReplyLog', productReplyLogSchema);
