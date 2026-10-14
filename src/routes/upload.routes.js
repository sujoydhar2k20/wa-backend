const express = require('express');
const router = express.Router();
const uploadController = require('../controllers/upload.controller');
const { uploader, ensureDiskSpace } = require('../middleware/mediaUpload.middleware');
const { authenticate } = require('../middleware/auth.middleware');

router.post('/file', authenticate, ensureDiskSpace, uploader.single('file'), uploadController.uploadFile);

// Upload limit the app checks before uploading (so oversized files fail early with the real limit).
router.get('/limits', authenticate, (req, res) => {
    const config = require('../config');
    res.json({ success: true, maxFileSize: config.upload.maxFileSize });
});

module.exports = router;
