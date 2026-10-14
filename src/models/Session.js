const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    deviceType: { type: String, enum: ['web', 'android'] },
    deviceId: { type: String },
    accessToken: { type: String },
    refreshToken: { type: String, required: true },
    // The refresh token this one replaced, still accepted for a short time: if the phone lost the
    // refresh response (mobile network), retrying with its old token must not log the staff member out
    // (logout also unsubscribes the phone from notifications).
    previousRefreshToken: { type: String, index: true, sparse: true },
    previousValidUntil: { type: Date },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Session', sessionSchema);
