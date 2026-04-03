const mongoose = require('mongoose');

const apiKeySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    key: { type: String, required: true, unique: true, index: true },
    wabaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Waba', required: true },
    phoneNumberId: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    isActive: { type: Boolean, default: true },
    lastUsedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ApiKey', apiKeySchema);
