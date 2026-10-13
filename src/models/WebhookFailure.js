const mongoose = require('mongoose');

/**
 * An inbound WhatsApp message whose processing failed for a temporary reason (database unavailable,
 * network error...). Kept so it can be retried automatically and diagnosed; removed after 7 days.
 * Retries are safe: processing skips any message whose WhatsApp id is already stored.
 */
const webhookFailureSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['message'], default: 'message' },
    messageId: { type: String, index: true },        // WhatsApp message id
    messageType: { type: String },
    wabaMetaId: { type: String },                    // entry.id
    phoneNumberId: { type: String },
    // The single message plus the sender's contact entry (needed to process it again).
    payload: { type: mongoose.Schema.Types.Mixed },
    error: { type: String },                         // error name + message, never message content
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, index: true },
    resolvedAt: { type: Date },
    gaveUpAt: { type: Date },
  },
  { timestamps: true }
);

webhookFailureSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
webhookFailureSchema.index({ messageId: 1, kind: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('WebhookFailure', webhookFailureSchema);
