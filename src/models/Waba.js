const mongoose = require('mongoose');

const phoneNumberSchema = new mongoose.Schema({
  phoneNumberId: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  displayName: { type: String },
  verifiedName: { type: String },
  qualityRating: { type: String },
  isDefault: { type: Boolean, default: false },
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
