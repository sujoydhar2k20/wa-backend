const mongoose = require('mongoose');

const SubCategorySchema = new mongoose.Schema({
    name: { type: String, required: true },
    link: { type: String, required: true },
}, { _id: true });

const AiCategorySchema = new mongoose.Schema({
    name: { type: String, required: true },
    link: { type: String, required: true },
    subcategories: [SubCategorySchema],
}, { timestamps: true });

module.exports = mongoose.model('AiCategory', AiCategorySchema);
