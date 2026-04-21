const express = require('express');
const router = express.Router();
const aiSettingsController = require('../controllers/aiSettings.controller');
const aiCategoriesController = require('../controllers/aiCategories.controller');
const { authenticate, requireAdmin } = require('../middleware/auth.middleware');

router.use(authenticate);
// Ensure only admins can modify AI settings
router.use(requireAdmin);

// AI Settings
router.get('/ai', aiSettingsController.getAiSettings);
router.put('/ai', aiSettingsController.updateAiSettings);

// AI Categories CRUD
router.get('/ai/categories', aiCategoriesController.listCategories);
router.post('/ai/categories', aiCategoriesController.createCategory);
router.put('/ai/categories/:id', aiCategoriesController.updateCategory);
router.delete('/ai/categories/:id', aiCategoriesController.deleteCategory);

// Subcategory management
router.post('/ai/categories/:id/subcategories', aiCategoriesController.addSubcategory);
router.put('/ai/categories/:id/subcategories/:subId', aiCategoriesController.updateSubcategory);
router.delete('/ai/categories/:id/subcategories/:subId', aiCategoriesController.deleteSubcategory);

module.exports = router;
