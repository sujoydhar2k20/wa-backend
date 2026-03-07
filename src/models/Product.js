const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    category: { type: String, enum: ['gold', 'diamond', 'silver'], required: true, index: true },
    name: { type: String },
    sku: { type: String },
    carat: { type: Number },
    weight: { type: Number },
    makingCharge: { type: Number },
    extraCharge: { type: Number },
    price: { type: Number },
    isInStock: { type: Boolean, default: true },
    description: { type: String },
    metadata: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

productSchema.index({ category: 1, code: 1 });
module.exports = mongoose.model('Product', productSchema);
