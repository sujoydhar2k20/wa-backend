const express = require('express');
const router = express.Router();
const ratesController = require('../controllers/rates.controller');
const { requireToken, requireAdmin } = require('../middleware/auth.middleware');

router.get('/', requireToken, ratesController.getRates);
router.put('/', requireToken, requireAdmin, ratesController.updateRates);

module.exports = router;
