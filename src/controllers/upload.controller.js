const fs = require('fs');
const path = require('path');
const mediaService = require('../services/media.service');
const { logger } = require('../utils/logger');
const vps = require('../utils/vpsUpload');
const { UPLOAD_FOLDER } = require('../middleware/mediaUpload.middleware');

/**
 * POST /upload/file — the file has already been streamed to disk by multer (".part").
 * Response contract unchanged: { success, url, mediaId, type } (+ size).
 */
async function uploadFile(req, res, next) {
  const partPath = req.file?.path;
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    const mimeType = req.file.mimetype;
    const originalName = req.file.originalname;
    const size = req.file.size;
    if (!size) {
      await fs.promises.unlink(partPath).catch(() => {});
      return res.status(400).json({ success: false, error: 'The file is empty' });
    }

    const finalName = req.file.finalName || path.basename(partPath).replace(/\.part$/, '');
    const finalPath = path.join(path.dirname(partPath), finalName);
    await fs.promises.rename(partPath, finalPath);
    const uploadedUrl = `${vps.UPLOAD_BASE_URL}/${UPLOAD_FOLDER}/${finalName}`;
    logger.info(`File uploaded to VPS: ${uploadedUrl} (${size} bytes)`);

    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 3);
    const type = (mimeType && mimeType.split('/')[0]) || 'application';
    const mediaType = ['image', 'video', 'audio'].includes(type) ? type : 'document';

    const media = await mediaService.saveMediaMetadata({
      url: uploadedUrl,
      type: mediaType,
      mimeType,
      fileName: originalName,
      fileSize: size,
      expiresAt,
    });

    res.json({
      success: true,
      url: uploadedUrl,
      mediaId: media._id,
      type: media.type,
      size,
    });
  } catch (error) {
    if (partPath) await fs.promises.unlink(partPath).catch(() => {});
    logger.error('Upload error', { error: error.message, stack: error.stack });
    next(error);
  }
}

module.exports = { uploadFile };
