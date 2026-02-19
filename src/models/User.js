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
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
