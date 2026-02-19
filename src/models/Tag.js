const mongoose = require('mongoose');

const tagSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, index: true },
    color: { type: String, required: true },
    description: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Tag', tagSchema);
