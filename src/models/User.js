const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    role: { type: String, enum: ['superadmin', 'admin', 'staff'], default: 'staff' },
    name: { type: String, required: true },
    email: { type: String },
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date },
    loginExpiry: { type: Date },
    refreshToken: { type: String },
    assignedWabaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Waba', default: null, index: true },
    pushSubscriptions: { type: Array, default: [] },
    isDnd: { type: Boolean, default: false },
    profilePicture: { type: String, default: null },
    primaryChannel: { type: String, default: null },
    fcmTokens: { type: [String], default: [] },
    // WhatsApp calling account on the PBX (Asterisk). Created automatically for active users.
    sip: {
      passwordEnc: { type: String, select: false }, // AES-256-GCM, see services/calls/sipAccounts.js
      deskPhone: { type: Boolean, default: false },  // also create a TLS account for Linphone/desk phones
      androidAppAt: { type: Date },                   // last time the Android app fetched its calling account
      createdAt: { type: Date },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
