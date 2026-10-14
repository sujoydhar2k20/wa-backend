'use strict';

/**
 * Disk-backed upload for POST /upload/file (chat attachments).
 * The file is streamed straight to the upload folder as "<name>.part" (no whole-file copy in RAM) and
 * renamed to its final name by the controller only after it was fully received and recorded.
 * Interrupted uploads leave only ".part" files, removed by the cleanup job.
 */
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const vps = require('../utils/vpsUpload');

const UPLOAD_FOLDER = 'uploads';
// Keep this much free space beyond the file itself (logs, DB, ffmpeg temp files).
const RESERVE_BYTES = 512 * 1024 * 1024;

function targetDir() {
  return path.join(vps.UPLOAD_BASE_DIR, UPLOAD_FOLDER);
}

function safeExtension(originalName, mimeType) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
  return vps.extensionFromMime(mimeType) || '';
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      fs.mkdirSync(targetDir(), { recursive: true });
      cb(null, targetDir());
    } catch (e) {
      cb(e);
    }
  },
  filename(req, file, cb) {
    const finalName = vps.generateFilename(file.originalname, safeExtension(file.originalname, file.mimetype));
    file.finalName = finalName;
    cb(null, `${finalName}.part`);
  },
});

const uploader = multer({ storage, limits: { fileSize: config.upload.maxFileSize, files: 1 } });

/** Refuse early (507) when the disk cannot take another maximum-size upload. */
async function ensureDiskSpace(req, res, next) {
  try {
    fs.mkdirSync(targetDir(), { recursive: true });
    const st = await fs.promises.statfs(targetDir());
    const free = Number(st.bavail) * Number(st.bsize);
    if (free < config.upload.maxFileSize + RESERVE_BYTES) {
      return res.status(507).json({ success: false, code: 'DISK_FULL', message: 'The server is low on storage space. Please try again later.' });
    }
  } catch {
    // statfs not available: do not block uploads on it
  }
  return next();
}

module.exports = { uploader, ensureDiskSpace, UPLOAD_FOLDER, targetDir };
