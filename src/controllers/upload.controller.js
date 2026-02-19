const axios = require('axios');
const FormData = require('form-data');
const mediaService = require('../services/media.service');
const { logger } = require('../utils/logger');

const EXTERNAL_UPLOAD_API = 'https://dash.biswakarmagold.com/api/upload/file';

async function uploadFile(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const fileType = req.body.type || 'image';
    const buffer = req.file.buffer;
    const mimeType = req.file.mimetype;
    const originalName = req.file.originalname;

    // Forward file to external upload API
    const formData = new FormData();
    formData.append('file', buffer, {
      filename: originalName,
      contentType: mimeType,
    });
    formData.append('type', fileType);

    const response = await axios.post(EXTERNAL_UPLOAD_API, formData, {
      headers: {
        ...formData.getHeaders(),
      },
    });

    if (!response.data.success || !response.data.url) {
      throw new Error(response.data.error || 'Image upload failed');
    }

    const uploadedUrl = response.data.url;

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
