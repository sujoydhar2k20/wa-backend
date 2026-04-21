const axios = require('axios');
const mediaService = require('../services/media.service');
const { logger } = require('../utils/logger');
const { uploadToVPS } = require('../utils/vpsUpload');

async function uploadFile(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const fileType = req.body.type || 'image';
    const buffer = req.file.buffer;
    const mimeType = req.file.mimetype;
    const originalName = req.file.originalname;

    // Upload to VPS instead of Cloudinary
    const uploadedUrl = await uploadToVPS(buffer, {
      folder: 'uploads',
      fileName: originalName,
      mimeType: mimeType,
    });

    // Save media metadata to database
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 3);
    const type = (mimeType && mimeType.split('/')[0]) || 'application';
    const mediaType = ['image', 'video', 'audio'].includes(type) ? type : 'document';

    const media = await mediaService.saveMediaMetadata({
      url: uploadedUrl,
      type: mediaType,
      mimeType,
      fileName: originalName,
      fileSize: buffer.length,
      expiresAt,
    });

    res.json({
      success: true,
      url: uploadedUrl,
      mediaId: media._id,
      type: media.type,
    });
  } catch (error) {
    logger.error('Upload error', { error: error.message, stack: error.stack });
    if (error.response) {
      return res.status(error.response.status || 500).json({
        success: false,
        error: error.response.data?.error || error.message || 'Upload failed',
      });
    }
    next(error);
  }
}

module.exports = { uploadFile };
