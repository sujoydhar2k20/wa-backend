const express = require('express');
const router = express.Router();
const botController = require('../controllers/bot.controller');
const { authenticate, requireAdmin } = require('../middleware/auth.middleware');

router.use(authenticate);
router.get('/flows', botController.listFlows);
router.post('/flows', requireAdmin, botController.createFlow);
router.get('/flows/:id', botController.getFlow);
router.put('/flows/:id', requireAdmin, botController.updateFlow);
router.delete('/flows/:id', requireAdmin, botController.removeFlow);
router.post('/flows/:id/enable', requireAdmin, botController.enable);
router.post('/flows/:id/disable', requireAdmin, botController.disable);
router.get('/flows/:id/executions', botController.getExecutions);

module.exports = router;
