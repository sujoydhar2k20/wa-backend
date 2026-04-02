const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema(
  {
    wabaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Waba', required: true, index: true },
    phoneNumberId: { type: String, required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', index: true },
    phoneNumber: { type: String, required: true, index: true },
    waId: { type: String, required: true, index: true },
    status: { type: String, enum: ['open', 'closed', 'awaiting_reply'], default: 'open', index: true },
    isUnread: { type: Boolean, default: true },
    isManuallyUnread: { type: Boolean, default: false },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    collaborators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    tags: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Tag' }],
    sessionExpiresAt: { type: Date, index: true },
    lastMessageAt: { type: Date },
    lastCustomerMessageAt: { type: Date },
    lastStaffMessageAt: { type: Date },
    closedAt: { type: Date },
  },
  { timestamps: true }
);

chatSchema.index({ wabaId: 1, waId: 1 }, { unique: true });
chatSchema.index({ assignedTo: 1, status: 1 });
module.exports = mongoose.model('Chat', chatSchema);
