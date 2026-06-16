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
    broadcastListId: { type: mongoose.Schema.Types.ObjectId, ref: 'BroadcastList' },
    tagIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Tag' }],
    status: { type: String, enum: ['draft', 'scheduled', 'sending', 'paused', 'completed', 'failed'], default: 'draft', index: true },
    scheduledAt: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },
    totalBatches: { type: Number, default: 1 },
    currentBatch: { type: Number, default: 1 },
    nextBatchAt: { type: Date },
    dailyLimit: { type: Number }, // Snapshot of the WABA limit when broadcast was created
    components: { type: [mongoose.Schema.Types.Mixed], default: [] }, // Template variable components sent to Meta API
    variableMapping: { type: [mongoose.Schema.Types.Mixed], default: [] }, // Maps variables to contact fields for dynamic resolution
    statistics: { type: statsSchema, default: () => ({}) },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Broadcast', broadcastSchema);
