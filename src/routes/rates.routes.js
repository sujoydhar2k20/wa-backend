const express = require('express');
const router = express.Router();
const ratesController = require('../controllers/rates.controller');
const { authenticate, requireAdmin } = require('../middleware/auth.middleware');

router.get('/', authenticate, ratesController.getRates);
router.put('/', authenticate, requireAdmin, ratesController.updateRates);

module.exports = router;
