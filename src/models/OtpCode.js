const mongoose = require('mongoose');

// One pending login OTP per phone number. Kept in MongoDB (not process memory) so it survives a
// backend restart and is shared by every backend process. MongoDB deletes the row by itself once
// expiresAt has passed (TTL index).
const otpCodeSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true },
    otp: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    lastSentAt: { type: Date, required: true },
    sendCount: { type: Number, default: 1 },
    failedAttempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

otpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('OtpCode', otpCodeSchema);
