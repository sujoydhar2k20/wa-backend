const express = require('express');
const router = express.Router();
const proxyController = require('../controllers/proxy.controller');

// Proxy Routes to bypass CORS for client.biswakarmagold.com

// GET /api/proxy/categories/tree
router.get('/categories/tree', proxyController.getCategoriesTree);

// GET /api/proxy/products/list
router.get('/products/list', proxyController.getProductsList);

module.exports = router;
