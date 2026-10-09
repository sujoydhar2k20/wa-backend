const mongoose = require('mongoose');

const broadcastMessageSchema = new mongoose.Schema(
  {
    broadcastId: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', required: true, index: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
    phoneNumber: { type: String, required: true },
    messageId: { type: String },
    status: { type: String, enum: ['sent', 'delivered', 'read', 'failed', 'skipped'], default: 'sent' },
    reactions: [{ emoji: String, count: { type: Number, default: 1 } }],
    repliedAt: { type: Date },
    
    // Original error information
    errorCode: { type: Number },
    errorMessage: { type: String },
    
    // Error classification and retry tracking
    errorClassification: { type: String, enum: ['RETRYABLE_TRANSIENT', 'RETRYABLE_THROTTLED', 'NON_RETRYABLE', 'INVESTIGATE'], default: null },
    errorCategory: { type: String }, // 'Server Issue', 'Phone Quality', 'Recipient Invalid', etc.
    errorRecommendation: { type: String }, // User-friendly recommendation
    
    // Retry tracking
    retryAttempts: { type: Number, default: 0 },
    maxRetryAttempts: { type: Number, default: 0 },
    lastRetryAt: { type: Date },
    nextRetryAt: { type: Date }, // Scheduled time for next retry
    retryHistory: [{
      attemptNumber: { type: Number },
      retriedAt: { type: Date },
      result: { type: String, enum: ['success', 'failed'] },
      errorCode: { type: Number },
      errorMessage: { type: String },
    }],
  },
  { timestamps: true }
);

// Index for finding messages ready to retry
broadcastMessageSchema.index({ status: 1, nextRetryAt: 1 });
broadcastMessageSchema.index({ broadcastId: 1, status: 1, errorClassification: 1 });

module.exports = mongoose.model('BroadcastMessage', broadcastMessageSchema);
