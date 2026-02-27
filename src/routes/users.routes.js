const express = require('express');
const router = express.Router();
const usersController = require('../controllers/users.controller');
const { authenticate, requireAdmin } = require('../middleware/auth.middleware');

router.use(authenticate);
router.get('/staff', usersController.listStaff); // accessible by all authenticated users for reassignment
router.get('/', requireAdmin, usersController.list);
router.post('/', requireAdmin, usersController.create);
router.get('/:id', usersController.get);
router.put('/:id', usersController.update);
router.delete('/:id', requireAdmin, usersController.remove);
router.get('/:id/sessions', requireAdmin, usersController.getSessions);
router.delete('/:id/sessions/:sessionId', requireAdmin, usersController.revokeSession);

module.exports = router;
