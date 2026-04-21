const { AiCategory } = require('../models');

// List all categories
async function listCategories(req, res, next) {
    try {
        const categories = await AiCategory.find().sort({ createdAt: 1 }).lean();
        res.json({ success: true, data: categories });
    } catch (e) {
        next(e);
    }
}

// Create a new main category
async function createCategory(req, res, next) {
    try {
        const { name, link, subcategories } = req.body;
        if (!name || !link) return res.status(400).json({ success: false, message: 'Name and link are required' });
        const category = await AiCategory.create({ name, link, subcategories: subcategories || [] });
        res.status(201).json({ success: true, data: category });
    } catch (e) {
        next(e);
    }
}

// Update a main category (name, link, or full subcategories array)
async function updateCategory(req, res, next) {
    try {
        const { id } = req.params;
        const { name, link, subcategories } = req.body;
        const update = {};
        if (name !== undefined) update.name = name;
        if (link !== undefined) update.link = link;
        if (subcategories !== undefined) update.subcategories = subcategories;

        const category = await AiCategory.findByIdAndUpdate(id, { $set: update }, { new: true });
        if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
        res.json({ success: true, data: category });
    } catch (e) {
        next(e);
    }
}

// Delete a main category
async function deleteCategory(req, res, next) {
    try {
        const { id } = req.params;
        const category = await AiCategory.findByIdAndDelete(id);
        if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
        res.json({ success: true, message: 'Category deleted' });
    } catch (e) {
        next(e);
    }
}

// Add a subcategory to an existing main category
async function addSubcategory(req, res, next) {
    try {
        const { id } = req.params;
        const { name, link } = req.body;
        if (!name || !link) return res.status(400).json({ success: false, message: 'Name and link are required' });
        const category = await AiCategory.findByIdAndUpdate(
            id,
            { $push: { subcategories: { name, link } } },
            { new: true }
        );
        if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
        res.json({ success: true, data: category });
    } catch (e) {
        next(e);
    }
}

// Update a subcategory
async function updateSubcategory(req, res, next) {
    try {
        const { id, subId } = req.params;
        const { name, link } = req.body;
        const update = {};
        if (name !== undefined) update['subcategories.$.name'] = name;
        if (link !== undefined) update['subcategories.$.link'] = link;

        const category = await AiCategory.findOneAndUpdate(
            { _id: id, 'subcategories._id': subId },
            { $set: update },
            { new: true }
        );
        if (!category) return res.status(404).json({ success: false, message: 'Category or subcategory not found' });
        res.json({ success: true, data: category });
    } catch (e) {
        next(e);
    }
}

// Delete a subcategory
async function deleteSubcategory(req, res, next) {
    try {
        const { id, subId } = req.params;
        const category = await AiCategory.findByIdAndUpdate(
            id,
            { $pull: { subcategories: { _id: subId } } },
            { new: true }
        );
        if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
        res.json({ success: true, data: category });
    } catch (e) {
        next(e);
    }
}

module.exports = {
    listCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    addSubcategory,
    updateSubcategory,
    deleteSubcategory,
};
