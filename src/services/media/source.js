'use strict';

/**
 * Where the bytes of a message's mediaUrl come from.
 *
 * Our own uploads (https://upload.biswakarmagold.com/...) are read straight from disk instead of being
 * downloaded again through public HTTPS + nginx. Any other http(s) URL is downloaded (streamed) to a
 * temporary file, as before. Nothing here loads a whole file into memory.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const vps = require('../../utils/vpsUpload');
const { TIMEOUTS, META_LIMITS } = require('./limits');

class MediaSourceError extends Error {
  constructor(message, code = 'MEDIA_SOURCE') {
    super(message);
    this.code = code;
    this.permanent = true;
  }
}

function baseDir() {
  return path.resolve(vps.UPLOAD_BASE_DIR);
}

/**
 * Map a URL of our upload host to a file inside the upload folder, or return null when the URL is not ours.
 * Throws for URLs that are ours but unsafe (traversal, encoded separators, symlink escape) or missing.
 */
async function resolveLocalUploadPath(mediaUrl) {
  let url;
  let base;
  try {
    url = new URL(String(mediaUrl));
    base = new URL(`${vps.UPLOAD_BASE_URL}/`);
  } catch {
    return null;
  }
  if (url.protocol !== base.protocol || url.host.toLowerCase() !== base.host.toLowerCase()) return null;
  if (url.search || url.hash) return null; // our files never carry a query; let the HTTP path handle oddities
  if (!url.pathname.startsWith(base.pathname)) return null;

  const rel = url.pathname.slice(base.pathname.length);
  const segments = rel.split('/');
  const decoded = [];
  for (const seg of segments) {
    let s;
    try {
      s = decodeURIComponent(seg);
    } catch {
      throw new MediaSourceError('Invalid media file reference', 'MEDIA_PATH_INVALID');
    }
    if (!s || s === '.' || s === '..' || /[\\/\0]/.test(s)) {
      throw new MediaSourceError('Invalid media file reference', 'MEDIA_PATH_INVALID');
    }
    decoded.push(s);
  }
  const root = baseDir();
  const candidate = path.resolve(root, ...decoded);
  if (!candidate.startsWith(root + path.sep)) {
    throw new MediaSourceError('Invalid media file reference', 'MEDIA_PATH_INVALID');
  }
  let real;
  let realRoot;
  try {
    [real, realRoot] = await Promise.all([fs.promises.realpath(candidate), fs.promises.realpath(root)]);
  } catch {
    throw new MediaSourceError('The uploaded file is no longer on the server. Please attach it again.', 'MEDIA_FILE_MISSING');
  }
  if (!real.startsWith(realRoot + path.sep)) {
    throw new MediaSourceError('Invalid media file reference', 'MEDIA_PATH_INVALID');
  }
  const st = await fs.promises.stat(real);
  if (!st.isFile()) throw new MediaSourceError('Invalid media file reference', 'MEDIA_PATH_INVALID');
  return { path: real, size: st.size };
}

function newTempPath(ext = '') {
  const dir = path.join(os.tmpdir(), 'bjs-media');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${Date.now()}_${process.pid}_${crypto.randomBytes(6).toString('hex')}${ext}`);
}

async function safeUnlink(p) {
  if (!p) return;
  await fs.promises.unlink(p).catch(() => {});
}

/**
 * Download a non-local URL to a temp file (streamed, size-capped). The caller must call cleanup().
 */
async function downloadToTemp(mediaUrl, { maxBytes = META_LIMITS.document + 1, timeout = TIMEOUTS.externalFetch } = {}) {
  const axios = require('axios');
  if (!/^https?:\/\//i.test(String(mediaUrl))) {
    throw new MediaSourceError('Unsupported media URL', 'MEDIA_URL_UNSUPPORTED');
  }
  const tmp = newTempPath();
  try {
    const response = await axios.get(mediaUrl, {
      responseType: 'stream',
      timeout,
      maxContentLength: maxBytes,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WhatsApp-Bot/1.0)' },
    });
    const data = response.data;
    if (Buffer.isBuffer(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      // (some adapters/mocks return a buffer even when a stream was asked for)
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer || data);
      if (buf.length > maxBytes) throw new MediaSourceError('The file is too large', 'MEDIA_TOO_LARGE');
      await fs.promises.writeFile(tmp, buf);
    } else {
      let seen = 0;
      data.on('data', (chunk) => {
        seen += chunk.length;
        if (seen > maxBytes) data.destroy(new MediaSourceError('The file is too large', 'MEDIA_TOO_LARGE'));
      });
      await pipeline(data, fs.createWriteStream(tmp));
    }
    const st = await fs.promises.stat(tmp);
    const header = String(response.headers?.['content-type'] || '').split(';')[0].trim() || null;
    return { path: tmp, size: st.size, headerMime: header, local: false, cleanup: () => safeUnlink(tmp) };
  } catch (e) {
    await safeUnlink(tmp);
    throw e;
  }
}

/**
 * Open the bytes behind a message's mediaUrl.
 * Returns { path, size, local, headerMime, cleanup }. `cleanup` never deletes our own uploaded file.
 */
async function openMediaSource(mediaUrl, opts = {}) {
  const local = await resolveLocalUploadPath(mediaUrl);
  if (local) return { ...local, local: true, headerMime: null, cleanup: async () => {} };
  return downloadToTemp(mediaUrl, opts);
}

module.exports = {
  MediaSourceError, resolveLocalUploadPath, openMediaSource, downloadToTemp, newTempPath, safeUnlink,
};
