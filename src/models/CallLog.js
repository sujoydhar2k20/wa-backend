const mongoose = require('mongoose');

const callLogSchema = new mongoose.Schema(
  {
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', index: true },
    wabaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Waba', required: true, index: true },
    phoneNumberId: { type: String, required: true },
    callId: { type: String, index: true, sparse: true }, // Meta's unique call identifier
    waId: { type: String, required: true, index: true },  // Customer phone number
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    status: {
      type: String,
      enum: [
        'permission_requested',
        'permission_granted',
        'ringing',
        'accepted',
        'rejected',
        'terminated',
        'missed',
        'failed',
      ],
      default: 'ringing',
    },
    duration: { type: Number, default: 0 }, // seconds
    initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // staff who placed outbound call
    startedAt: { type: Date },   // when the call started ringing
    answeredAt: { type: Date },  // when the call was answered
    endedAt: { type: Date },     // when the call terminated
    metadata: { type: mongoose.Schema.Types.Mixed }, // biz_opaque_callback_data, SDP, etc.
  },
  { timestamps: true }
);

callLogSchema.index({ chatId: 1, createdAt: -1 });
callLogSchema.index({ wabaId: 1, createdAt: -1 });

module.exports = mongoose.model('CallLog', callLogSchema);
