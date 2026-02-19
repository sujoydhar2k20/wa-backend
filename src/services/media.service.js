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

async function saveFile(buffer, mimeType, options = {}) {
  const { messageId, mediaId, fileName: providedFileName } = options;
  await ensureUploadDir();
  let filename;
  if (providedFileName) {
    const ext = path.extname(providedFileName) || (mimeType && mimeType.split('/')[1] ? `.${mimeType.split('/')[1].replace(/\+.*/, '')}` : '');
    const baseName = path.basename(providedFileName, path.extname(providedFileName));
    filename = `${Date.now()}-${baseName}${ext}`;
  } else {
    const ext = (mimeType && mimeType.split('/')[1]) ? mimeType.split('/')[1].replace(/\+.*/, '') : 'bin';
    filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  }
  const fullPath = path.join(UPLOAD_DIR, MEDIA_SUBDIR, filename);
  await fs.writeFile(fullPath, buffer);
  const relativePath = getRelativePath(filename);
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + RETENTION_YEARS);
  const type = (mimeType && mimeType.split('/')[0]) || 'application';
  const mediaType = ['image', 'video', 'audio'].includes(type) ? type : 'document';
  const doc = await Media.create({
    messageId,
    mediaId,
    url: relativePath,
    type: mediaType,
    mimeType,
    fileName: filename,
    fileSize: buffer.length,
    expiresAt,
  });
  return doc;
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
  saveFile,
  saveMediaMetadata,
  getAbsolutePath,
  getRelativePath,
  ensureUploadDir,
  cleanupExpiredMedia,
  UPLOAD_DIR,
  MEDIA_SUBDIR,
};
