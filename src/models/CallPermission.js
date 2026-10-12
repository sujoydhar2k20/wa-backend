const mongoose = require('mongoose');

/**
 * A customer's permission for the business to call them on WhatsApp (per business phone number).
 * Updated from call_permission_reply webhooks; requests are tracked to respect Meta's limits.
 */
const callPermissionSchema = new mongoose.Schema(
  {
    wabaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Waba', required: true },
    phoneNumberId: { type: String, required: true },
    waId: { type: String, required: true },
    status: { type: String, enum: ['none', 'granted', 'declined'], default: 'none' },
    isPermanent: { type: Boolean, default: false },
    expiresAt: { type: Date },
    source: { type: String },          // user_action | automatic
    lastReplyAt: { type: Date },
    requests: [{ at: Date, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, messageId: String }],
  },
  { timestamps: true }
);

callPermissionSchema.index({ phoneNumberId: 1, waId: 1 }, { unique: true });

module.exports = mongoose.model('CallPermission', callPermissionSchema);
