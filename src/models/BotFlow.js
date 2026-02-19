const mongoose = require('mongoose');

const triggerSchema = new mongoose.Schema({
  type: { type: String, enum: ['on_message', 'on_agent_connected', 'on_close', 'on_open'], default: 'on_message' },
  keywords: [String],
  matchType: { type: String, enum: ['exact', 'partial', 'regex'], default: 'partial' },
  partiallyMatch: { type: Boolean, default: true },
}, { _id: false });

const nodeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  type: { type: String, enum: ['send_message', 'send_template', 'send_interactive', 'time_delay', 'condition', 'opt_out', 'set_attribute'], required: true },
  config: mongoose.Schema.Types.Mixed,
}, { _id: false });

const edgeSchema = new mongoose.Schema({
  from: String,
  to: String,
  condition: String,
}, { _id: false });

const scheduleDaySchema = new mongoose.Schema({
  day: { type: Number, min: 0, max: 6 },
  startTime: String,
  endTime: String,
  isWorking: { type: Boolean, default: true },
}, { _id: false });

const workingHoursSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  timezone: { type: String, default: 'UTC' },
  schedule: [scheduleDaySchema],
}, { _id: false });

const botFlowSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String },
    isEnabled: { type: Boolean, default: false },
    version: { type: Number, default: 1 },
    trigger: { type: triggerSchema, default: () => ({}) },
    nodes: [nodeSchema],
    edges: [edgeSchema],
    workingHours: { type: workingHoursSchema, default: () => ({}) },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BotFlow', botFlowSchema);
