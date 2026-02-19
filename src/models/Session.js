const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    deviceType: { type: String, enum: ['web', 'android'] },
    deviceId: { type: String },
    accessToken: { type: String },
    refreshToken: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Session', sessionSchema);
