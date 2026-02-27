const fs = require('fs').promises;
const path = require('path');
const config = require('../config');
const Media = require('../models/Media');
const { logger } = require('../utils/logger');

const UPLOAD_DIR = config.upload.dir || './uploads';
const MEDIA_SUBDIR = 'media';
const RETENTION_YEARS = 3;

async function ensureUploadDir() {
  const full = path.join(UPLOAD_DIR, MEDIA_SUBDIR);
  await fs.mkdir(full, { recursive: true });
  return full;
}

function getRelativePath(filename) {
  return path.join(MEDIA_SUBDIR, filename).replace(/\\/g, '/');
}


async function saveMediaMetadata(options) {
  const { url, type, mimeType, fileName, fileSize, expiresAt, messageId, mediaId } = options;
  const doc = await Media.create({
    messageId,
    mediaId,
    url,
    type,
    mimeType,
    fileName,
    fileSize,
    expiresAt,
  });
  return doc;
}

function getAbsolutePath(relativeUrl) {
  return path.join(UPLOAD_DIR, relativeUrl);
}

async function cleanupExpiredMedia() {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - RETENTION_YEARS);
  // Files are stored on external server, just clean up database records
  const result = await Media.deleteMany({ expiresAt: { $lt: cutoff } });
  logger.info('Media cleanup', { deleted: result.deletedCount });
  return result.deletedCount;
}

module.exports = {
  saveMediaMetadata,
  getAbsolutePath,
  getRelativePath,
  ensureUploadDir,
  cleanupExpiredMedia,
  UPLOAD_DIR,
  MEDIA_SUBDIR,
};
