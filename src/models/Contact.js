const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema(
  {
    phoneNumber: { type: String, required: true, index: true },
    waId: { type: String, index: true },
    name: { type: String },
    nameOnWhatsApp: { type: String },
    profilePicture: { type: String },
    isOptedOut: { type: Boolean, default: false },
    isBlocked: { type: Boolean, default: false },
    optedOutAt: { type: Date },
    blockedAt: { type: Date },
    tags: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Tag' }],
    customFields: { type: Map, of: String, default: {} },
    lastContactedAt: { type: Date },
  },
  { timestamps: true }
);

contactSchema.index({ phoneNumber: 1, waId: 1 });
module.exports = mongoose.model('Contact', contactSchema);
