const express = require('express');
const router = express.Router();
const uploadController = require('../controllers/upload.controller');
const upload = require('../middleware/upload.middleware');
const { authenticate } = require('../middleware/auth.middleware');

router.post('/file', authenticate, upload.single('file'), uploadController.uploadFile);

module.exports = router;
