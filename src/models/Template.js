const mongoose = require('mongoose');

const templateComponentSchema = new mongoose.Schema({
  type: String,
  text: String,
  buttons: [mongoose.Schema.Types.Mixed],
  example: mongoose.Schema.Types.Mixed,
}, { _id: false });

const templateSchema = new mongoose.Schema(
  {
    wabaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Waba', required: true, index: true },
    templateId: { type: String },
    name: { type: String, required: true },
    language: { type: String, default: 'en' },
    category: { type: String, enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'] },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    components: [templateComponentSchema],
    metaData: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

templateSchema.index({ wabaId: 1, name: 1, language: 1 });
module.exports = mongoose.model('Template', templateSchema);
