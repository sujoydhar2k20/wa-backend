const mongoose = require('mongoose');

const broadcastListMemberSchema = new mongoose.Schema(
  {
    broadcastListId: { type: mongoose.Schema.Types.ObjectId, ref: 'BroadcastList', required: true, index: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', index: true },
    phoneNumber: { type: String, required: true, index: true },
    status: { type: String, enum: ['pending', 'sent', 'delivered', 'read', 'failed', 'opted_out'], default: 'pending' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

broadcastListMemberSchema.index({ broadcastListId: 1, phoneNumber: 1 }, { unique: true });
module.exports = mongoose.model('BroadcastListMember', broadcastListMemberSchema);
