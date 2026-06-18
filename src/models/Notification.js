const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['new_chat', 'escalation', 'unread_reminder', 'repeated_notification', 'assignment'],
      required: true,
      index: true
    },
    title: { type: String, required: true },
    body: { type: String, required: true },
    isRead: { type: Boolean, default: false, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Notification', notificationSchema);
