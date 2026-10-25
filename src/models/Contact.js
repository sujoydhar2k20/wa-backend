const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema(
  {
    // Phone identity (digits). Optional since WhatsApp usernames (see bsuid).
    phoneNumber: { type: String, index: true },
    waId: { type: String, index: true },
    // Business-scoped user ID and its parent (".ENT.") ID, WhatsApp username. Never stored as a phone.
    bsuid: { type: String, index: true },
    parentBsuid: { type: String },
    username: { type: String },
    previousBsuids: [{ type: String }],
    mergedInto: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
    // Result of the last block/unblock on WhatsApp itself (Meta Block Users API). isBlocked is the
    // local (BJS Connect) block, which always applies even when WhatsApp refuses or is unreachable.
    remoteBlock: {
      status: { type: String, enum: ['blocked', 'unblocked', 'failed', 'not_attempted'] },
      action: { type: String, enum: ['block', 'unblock'] },
      errorCode: Number,
      errorMessage: String,
      phoneNumberId: String,
      at: Date,
    },
    name: { type: String },
    nickname: { type: String },
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

contactSchema.pre('validate', function requireIdentity() {
  if (!this.mergedInto && !this.phoneNumber && !this.waId && !this.bsuid) this.invalidate('phoneNumber', 'A contact needs a phone number or a WhatsApp user ID');
});

contactSchema.index({ phoneNumber: 1, waId: 1 });
module.exports = mongoose.model('Contact', contactSchema);
