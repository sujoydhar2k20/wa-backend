const mongoose = require('mongoose');

/**
 * Audit trail of block / unblock actions: who did it, on which customer, and what happened locally
 * (BJS Connect) and on WhatsApp (Meta Block Users API). Identities are stored masked.
 */
const blockAuditSchema = new mongoose.Schema(
  {
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', index: true },
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', index: true },
    action: { type: String, enum: ['block', 'unblock'], required: true },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role: String,
    source: { type: String, enum: ['chat', 'contacts', 'api'], default: 'chat' },
    local: { type: String, enum: ['applied', 'unchanged'], required: true },
    remote: { type: String, enum: ['blocked', 'unblocked', 'failed', 'not_attempted'], required: true },
    remoteErrorCode: Number,
    remoteErrorMessage: String,
    phoneNumberId: String,
    identity: String, // masked, e.g. "phone …4521" or "user id …741918"
  },
  { timestamps: true }
);

blockAuditSchema.index({ createdAt: -1 });
module.exports = mongoose.model('BlockAudit', blockAuditSchema);
