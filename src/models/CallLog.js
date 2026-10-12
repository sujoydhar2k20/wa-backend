const mongoose = require('mongoose');

/**
 * One WhatsApp call (customer -> business, or business -> customer), carried over SIP via Asterisk.
 */
const callLogSchema = new mongoose.Schema(
  {
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', index: true },
    wabaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Waba', required: true, index: true },
    phoneNumberId: { type: String, required: true },
    waId: { type: String, required: true, index: true }, // customer number (digits) or BSUID
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    status: {
      type: String,
      enum: ['ringing', 'accepted', 'terminated', 'missed', 'rejected', 'failed', 'blocked',
        // legacy values kept so old documents still validate
        'permission_requested', 'permission_granted'],
      default: 'ringing',
      index: true,
    },
    callId: { type: String, index: true, sparse: true },      // WhatsApp call id (wacid...)
    asteriskUniqueId: { type: String, index: true, sparse: true },
    stage: { type: String, enum: ['assigned', 'all', null], default: null },
    ringTargets: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // everyone who was rung
    answeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    answeredDevice: { type: String },                          // 'web/app' (WebRTC) or 'desk'
    initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    duration: { type: Number, default: 0 },                    // talk time in seconds
    startedAt: { type: Date },
    answeredAt: { type: Date },
    endedAt: { type: Date },
    endReason: { type: String },                               // e.g. NOANSWER, BUSY, no_permission
    meta: {                                                    // Meta's own view (SIP webhooks)
      status: String,
      duration: Number,
      startTime: Date,
      endTime: Date,
      errors: mongoose.Schema.Types.Mixed,
    },
    recording: {
      status: { type: String, enum: ['none', 'pending', 'ready', 'failed', 'deleted'], default: 'none' },
      path: String,       // relative to CALL_RECORDINGS_DIR
      sizeBytes: Number,
      durationSec: Number,
    },
    missedMessageSentAt: { type: Date },
    chatMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

callLogSchema.index({ chatId: 1, createdAt: -1 });
callLogSchema.index({ wabaId: 1, createdAt: -1 });
callLogSchema.index({ createdAt: 1 });

module.exports = mongoose.model('CallLog', callLogSchema);
