const mongoose = require('mongoose');

const executionLogSchema = new mongoose.Schema({
  nodeId: String,
  action: String,
  result: mongoose.Schema.Types.Mixed,
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const botExecutionSchema = new mongoose.Schema(
  {
    flowId: { type: mongoose.Schema.Types.ObjectId, ref: 'BotFlow', required: true, index: true },
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
    currentNodeId: { type: String },
    status: { type: String, enum: ['running', 'completed', 'failed', 'stopped'], default: 'running', index: true },
    executionLog: [executionLogSchema],
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BotExecution', botExecutionSchema);
