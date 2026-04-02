const mongoose = require('mongoose');

const phoneNumberSchema = new mongoose.Schema({
  phoneNumberId: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  displayName: { type: String },
  verifiedName: { type: String },
  qualityRating: { type: String },
  isDefault: { type: Boolean, default: false },
  messagingLimitTier: { type: String, enum: ['TIER_1K', 'TIER_10K', 'TIER_100K', 'UNLIMITED', null], default: null },
  messagingLimit: { type: Number, default: 1000 }, // Resolved numeric limit from tier
}, { _id: false });

const wabaSchema = new mongoose.Schema(
  {
    wabaId: { type: String, required: true, unique: true, index: true },
    businessName: { type: String },
    accessToken: { type: String, required: true },
    appId: { type: String },
    appSecret: { type: String },
    webhookVerifyToken: { type: String },
    phoneNumbers: [phoneNumberSchema],
    rateLimitTier: { type: String },
    isActive: { type: Boolean, default: true },
    embeddedSignupToken: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Waba', wabaSchema);
