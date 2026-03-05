const mongoose = require('mongoose');

const importLogSchema = new mongoose.Schema({
  rowNumber: Number,
  status: { type: String, enum: ['success', 'error'] },
  error: String,
  data: mongoose.Schema.Types.Mixed,
}, { _id: false });

const mappingSchema = new mongoose.Schema({
  code: String,
  name: String,
  sku: String,
  type: String,
  carat: String,
  weight: String,
  makingCharge: String,
  extraCharge: String,
  price: String,
  images: String,
}, { _id: false });

const productImportSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true },
    filePath: { type: String, required: true },
    category: { type: String, enum: ['gold', 'diamond', 'silver'], required: true },
    status: { type: String, enum: ['queued', 'processing', 'completed', 'failed'], default: 'queued', index: true },
    totalRows: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    mapping: mappingSchema,
    importLog: [importLogSchema],
    importedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ProductImport', productImportSchema);
