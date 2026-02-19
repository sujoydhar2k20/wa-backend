const express = require('express');
const router = express.Router();
const notesController = require('../controllers/notes.controller');
const { authenticate } = require('../middleware/auth.middleware');

router.use(authenticate);
router.get('/chats/:chatId/notes', notesController.listByChat);
router.post('/chats/:chatId/notes', notesController.create);
router.put('/notes/:id', notesController.update);
router.delete('/notes/:id', notesController.remove);

module.exports = router;
