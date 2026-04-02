const mongoose = require('mongoose');

const broadcastBatchSchema = new mongoose.Schema(
  {
    broadcastId: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', required: true, index: true },
    batchNumber: { type: Number, required: true },
    scheduledAt: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'sending', 'completed', 'failed'], default: 'pending', index: true },
    memberPhones: [{ type: String }], // Phone numbers assigned to this batch
    memberCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

broadcastBatchSchema.index({ broadcastId: 1, batchNumber: 1 }, { unique: true });
broadcastBatchSchema.index({ status: 1, scheduledAt: 1 }); // For the cron/agenda query

module.exports = mongoose.model('BroadcastBatch', broadcastBatchSchema);
