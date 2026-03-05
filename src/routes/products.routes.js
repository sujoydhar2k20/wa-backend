const express = require('express');
const router = express.Router();
const productsController = require('../controllers/products.controller');
const { authenticate, requireAdmin } = require('../middleware/auth.middleware');
const upload = require('../middleware/upload.middleware');

router.use(authenticate);
router.get('/', productsController.list);
router.get('/search', productsController.searchByCode);
router.get('/imports', requireAdmin, productsController.listImports);
router.get('/imports/:id', requireAdmin, productsController.getImport);
router.get('/imports/:id/logs', requireAdmin, productsController.getImportLogs);
router.post('/import', requireAdmin, upload.single('file'), productsController.import);
router.post('/bulk-karat', requireAdmin, productsController.bulkUpdateKarat);
router.get('/:id', productsController.get);
router.post('/', requireAdmin, productsController.create);
router.put('/:id', requireAdmin, productsController.update);
router.delete('/:id', requireAdmin, productsController.remove);
router.post('/:id/images', requireAdmin, upload.single('image'), productsController.addImage);
router.delete('/:id/images', requireAdmin, productsController.removeImage);

module.exports = router;
