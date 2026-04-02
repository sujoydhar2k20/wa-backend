const mongoose = require('mongoose');

const statsSchema = new mongoose.Schema({
  total: { type: Number, default: 0 },
  sent: { type: Number, default: 0 },
  delivered: { type: Number, default: 0 },
  read: { type: Number, default: 0 },
  replied: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  optedOut: { type: Number, default: 0 },
}, { _id: false });

const broadcastSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    wabaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Waba', required: true, index: true },
    phoneNumberId: { type: String, required: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', required: true },
    broadcastListId: { type: mongoose.Schema.Types.ObjectId, ref: 'BroadcastList', required: true },
    status: { type: String, enum: ['draft', 'scheduled', 'sending', 'paused', 'completed', 'failed'], default: 'draft', index: true },
    scheduledAt: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },
    totalBatches: { type: Number, default: 1 },
    currentBatch: { type: Number, default: 1 },
    nextBatchAt: { type: Date },
    dailyLimit: { type: Number }, // Snapshot of the WABA limit when broadcast was created
    statistics: { type: statsSchema, default: () => ({}) },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Broadcast', broadcastSchema);
