const mongoose = require('mongoose');

const broadcastListSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String },
    wabaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Waba', required: true, index: true },
    memberCount: { type: Number, default: 0 },
    maxMembers: { type: Number, default: 100000 },
    source: { type: String, enum: ['manual', 'import', 'tags'], default: 'manual' },
    tags: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Tag' }],
    importedFile: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BroadcastList', broadcastListSchema);
