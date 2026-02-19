const mongoose = require('mongoose');

const chatActivitySchema = new mongoose.Schema(
  {
    chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
    type: {
      type: String,
      enum: ['tag_added', 'tag_removed', 'assigned', 'unassigned', 'transferred', 'closed', 'reopened', 'opt_in', 'opt_out', 'note_added'],
      required: true,
    },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    details: {
      tagId: mongoose.Schema.Types.ObjectId,
      tagName: String,
      assignedTo: mongoose.Schema.Types.ObjectId,
      transferredFrom: mongoose.Schema.Types.ObjectId,
      transferredTo: mongoose.Schema.Types.ObjectId,
      note: String,
    },
  },
  { timestamps: true }
);

chatActivitySchema.index({ chatId: 1, createdAt: -1 });
module.exports = mongoose.model('ChatActivity', chatActivitySchema);
