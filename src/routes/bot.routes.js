const express = require('express');
const router = express.Router();
const botController = require('../controllers/bot.controller');
const { authenticate, requireAdmin } = require('../middleware/auth.middleware');
const upload = require('../middleware/upload.middleware');
const mediaService = require('../services/media.service');
const { uploadToVPS } = require('../utils/vpsUpload');
const { logger } = require('../utils/logger');

router.use(authenticate);
router.get('/flows', botController.listFlows);
router.post('/flows', requireAdmin, botController.createFlow);
router.get('/flows/:id', botController.getFlow);
router.put('/flows/:id', requireAdmin, botController.updateFlow);
router.delete('/flows/:id', requireAdmin, botController.removeFlow);
router.post('/flows/:id/enable', requireAdmin, botController.enable);
router.post('/flows/:id/disable', requireAdmin, botController.disable);
router.get('/flows/:id/executions', botController.getExecutions);

// Dedicated bot image upload — uses same VPS + media pipeline as customer images
router.post('/upload-image', requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { buffer, mimetype, originalname } = req.file;

    // Validate it's an image
    if (!mimetype.startsWith('image/')) {
      return res.status(400).json({ success: false, error: 'Only image files are allowed' });
    }

    // Upload to VPS using the same utility as all other media
    const url = await uploadToVPS(buffer, {
      folder: 'bot-assets',
      fileName: originalname,
      mimeType: mimetype,
    });

    // Save media metadata to DB
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 3);

    const media = await mediaService.saveMediaMetadata({
      url,
      type: 'image',
      mimeType: mimetype,
      fileName: originalname,
      fileSize: buffer.length,
      expiresAt,
    });

    logger.info(`Bot image uploaded: ${url}`);

    res.json({ success: true, url, mediaId: media._id });
  } catch (err) {
    logger.error('Bot image upload error:', err.message);
    next(err);
  }
});

module.exports = router;
