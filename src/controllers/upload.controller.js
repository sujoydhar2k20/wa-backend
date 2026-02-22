const axios = require('axios');
const mediaService = require('../services/media.service');
const { logger } = require('../utils/logger');
const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');

// Will configure cloudinary when uploading using process.env

async function uploadFile(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const fileType = req.body.type || 'image';
    const buffer = req.file.buffer;
    const mimeType = req.file.mimetype;
    const originalName = req.file.originalname;

    const resourceType = ['video', 'audio'].includes(fileType) ? 'video' : 'auto';
    const uploadOptions = { folder: 'whatsapp-bot', resource_type: resourceType };

    // Force conversion to mp4 for audio/video to ensure WhatsApp compatibility
    if (fileType === 'audio' || fileType === 'video') {
      uploadOptions.format = 'mp4';
    }

    // Explicitly configure just in case it was lost
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });

    const uploadedUrl = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        uploadOptions,
        (error, result) => {
          if (error) return reject(new Error(error.message));
          resolve(result.secure_url);
        }
      );
      streamifier.createReadStream(buffer).pipe(uploadStream);
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
