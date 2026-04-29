const mongoose = require('mongoose');

const triggerSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: [
      'on_message',
      'on_agent_assign',
      'on_close_conversation',
      'on_first_daily_message',
      'on_new_lead',
      'on_open_conversation',
    ],
    default: 'on_message',
  },
  keywords: [String],
  matchType: { type: String, enum: ['exact', 'partial', 'regex'], default: 'partial' },
}, { _id: false });

const positionSchema = new mongoose.Schema({
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
}, { _id: false });

const nodeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  type: {
    type: String,
    enum: [
      'trigger',
      'send_message',
      'send_template',
      'send_interactive',
      'send_interactive_list',
      'time_delay',
      'condition',
      'assign_agent',
      'close_conversation',
      'opt_out',
      'wait_till',
      'working_hours_condition',
      'set_attribute',
    ],
    required: true,
  },
  label: { type: String, default: '' },
  config: mongoose.Schema.Types.Mixed,
  position: { type: positionSchema, default: () => ({ x: 0, y: 0 }) },
}, { _id: false });

const edgeSchema = new mongoose.Schema({
  id: String,
  source: String,
  target: String,
  sourceHandle: String,
  targetHandle: String,
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
    cooldownMinutes: { type: Number, default: 0 }, // 0 = no cooldown
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BotFlow', botFlowSchema);
