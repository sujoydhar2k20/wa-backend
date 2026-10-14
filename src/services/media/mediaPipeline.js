'use strict';

/**
 * The one outgoing-media pipeline used by every path that sends a photo/video/audio/document to WhatsApp:
 *   POST /messages/send (sync for old clients, async background job for new clients),
 *   POST /messages/:id/retry, and the bulk product-send job.
 *
 *   source   our own upload -> read from disk; anything else -> streamed download to a temp file
 *   prepare  imagePrep / videoPrep / audioPrep / documentPrep (pass-through when already acceptable)
 *   upload   streamed multipart upload to Meta -> media id (safe to retry: an unused upload is harmless)
 *   send     POST /{phone}/messages. NEVER retried blindly when the outcome is unknown (timeout / reset /
 *            gateway error): it is reported as `ambiguous` and reconciled via biz_opaque_callback_data.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const whatsappService = require('../whatsapp.service');
const { logger } = require('../../utils/logger');
const vps = require('../../utils/vpsUpload');
const { openMediaSource, newTempPath, safeUnlink } = require('./source');
const { prepareImage } = require('./imagePrep');
const { prepareVideo } = require('./videoPrep');
const { convertAudioFile, convertVoiceFile } = require('./audioPrep');
const { prepareDocument } = require('./documentPrep');
const { Semaphore } = require('./semaphore');
const { CONCURRENCY, META_MEDIA_REUSE_MS } = require('./limits');

const metaUploadSlots = new Semaphore(CONCURRENCY.metaUpload, 'metaUpload');
const MEDIA_TYPES = ['image', 'video', 'audio', 'document'];

/** Classify an error from a Meta HTTP call. */
function classifyMetaError(err) {
  const status = err?.response?.status;
  const metaErr = err?.response?.data?.error;
  if (status) {
    if (status === 429) return { kind: 'retry', reason: 'rate-limited' };
    if (status >= 500) {
      // A Graph error body means Meta answered "not processed"; a bare 5xx (gateway) is unknown.
      return metaErr ? { kind: 'retry', reason: `meta-${status}` } : { kind: 'ambiguous', reason: `http-${status}` };
    }
    return { kind: 'fatal', reason: `meta-${status}`, code: metaErr?.code, message: metaErr?.message };
  }
  const code = err?.code;
  // The connection was never made: the request certainly did not reach Meta.
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) {
    return { kind: 'retry', reason: code };
  }
  // Timeout, reset, socket hang up...: Meta may or may not have accepted it.
  return { kind: 'ambiguous', reason: code || 'network' };
}

/** Upload retry: uploading the same file twice is harmless, so 429/5xx/network errors are retried. */
async function uploadWithRetry(fn, { attempts = 3, baseMs = 1500 } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const status = e?.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600) || !status;
      if (!retryable || i === attempts) throw e;
      const delay = baseMs * 2 ** (i - 1);
      logger.warn(`Meta media upload failed (attempt ${i}/${attempts}, ${status || e.code || 'network'}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw last;
}

function preparedDir() {
  return path.join(vps.UPLOAD_BASE_DIR, 'prepared');
}

function extFor(mime) {
  return ({
    'image/jpeg': '.jpg', 'image/png': '.png', 'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a',
  })[mime] || '';
}

/**
 * Turn the message's mediaUrl into a file Meta accepts.
 * opts: { type, mediaUrl, wantsVoice, voiceRejected, keepPrepared }
 * Returns { file:{path,mimeType,size}, action, reasons, sentAsVoice, voiceNotice, timings, cleanup, persistedPath }
 */
async function prepareMedia({ type, mediaUrl, wantsVoice = false, voiceRejected = false, keepPrepared = false }) {
  const timings = {};
  const t0 = Date.now();
  const src = await openMediaSource(mediaUrl);
  timings.sourceMs = Date.now() - t0;
  timings.sourceLocal = src.local;
  const temps = [];
  const out = (ext) => {
    const p = newTempPath(ext);
    temps.push(p);
    return p;
  };
  let result;
  let sentAsVoice = false;
  let voiceNotice;
  const tp = Date.now();
  try {
    if (type === 'image') {
      result = await prepareImage(src.path, out('.img'));
    } else if (type === 'video') {
      result = await prepareVideo(src.path, out('.mp4'));
    } else if (type === 'audio') {
      if (wantsVoice && !voiceRejected) {
        try {
          const v = await convertVoiceFile(src.path, out('.ogg'));
          result = { ...v, action: 'voice' };
          sentAsVoice = true;
          if (v.oversize) voiceNotice = 'oversize';
        } catch (err) {
          // Never pretend: send it as an ordinary audio file and record why.
          logger.warn(`Voice note could not be converted to OGG/OPUS, sending as audio file: ${err.message}`);
          voiceNotice = 'opus_unavailable';
          result = { ...(await convertAudioFile(src.path, out('.m4a'))), action: 'audio' };
        }
      } else {
        result = { ...(await convertAudioFile(src.path, out('.m4a'))), action: 'audio' };
      }
    } else if (type === 'document') {
      result = await prepareDocument(src.path, { hintMime: src.headerMime, nameHint: mediaUrl });
    } else {
      throw new Error(`Unsupported media type: ${type}`);
    }
  } catch (e) {
    await Promise.all(temps.map(safeUnlink));
    await src.cleanup();
    throw e;
  }
  timings.prepareMs = Date.now() - tp;
  timings.prepareAction = result.action;
  if (result.convertMs != null) timings.convertMs = result.convertMs;

  let finalPath = result.path;
  let persistedPath = null;
  if (keepPrepared && result.path !== src.path) {
    // Keep a converted file so a later retry does not convert again (deleted once the message is sent).
    fs.mkdirSync(preparedDir(), { recursive: true });
    persistedPath = path.join(preparedDir(), `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${extFor(result.mimeType)}`);
    await fs.promises.rename(result.path, persistedPath).catch(async () => {
      await fs.promises.copyFile(result.path, persistedPath);
    });
    finalPath = persistedPath;
  }
  const cleanup = async () => {
    await Promise.all(temps.map(safeUnlink));
    await src.cleanup();
  };
  return {
    file: { path: finalPath, mimeType: result.mimeType, size: result.size },
    action: result.action,
    reasons: result.reasons || [],
    details: { width: result.width, height: result.height, duration: result.duration, inputBytes: src.size },
    sentAsVoice,
    voiceNotice,
    timings,
    cleanup,
    persistedPath,
  };
}

async function uploadToMeta(chat, file) {
  const t0 = Date.now();
  const id = await metaUploadSlots.run(() => uploadWithRetry(
    () => whatsappService.uploadMediaFile(chat.wabaId, chat.phoneNumberId, file.path, file.mimeType, file.size),
  ));
  return { mediaId: id, ms: Date.now() - t0 };
}

/**
 * Send the WhatsApp media message once. Returns
 *   { ok:true, wamid, ms } | { ok:false, kind:'fatal'|'retry'|'ambiguous', error, ms }
 * Only 429 / "connection never made" / Meta-answered 5xx are retried here (max 2 extra tries);
 * an ambiguous outcome is returned immediately and never re-sent automatically.
 */
async function sendOnce({ chat, to, type, mediaIdOrUrl, caption, replyWamid, voice, bizOpaque, retries = 2 }) {
  const t0 = Date.now();
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await whatsappService.sendMediaMessage(
        chat.wabaId, chat.phoneNumberId, to, type, mediaIdOrUrl, caption || '', replyWamid || null, { voice, bizOpaque },
      );
      const wamid = r?.messages?.[0]?.id;
      if (!wamid) return { ok: false, kind: 'ambiguous', error: new Error('Meta returned no message id'), ms: Date.now() - t0, raw: r };
      return { ok: true, wamid, ms: Date.now() - t0, raw: r };
    } catch (e) {
      lastErr = e;
      if (e.statusCode === 403 && !e.response) {
        return { ok: false, kind: 'fatal', error: e, ms: Date.now() - t0 }; // blocked / opted out (local guard)
      }
      const c = classifyMetaError(e);
      if (c.kind !== 'retry' || i === retries) return { ok: false, kind: c.kind, error: e, reason: c.reason, ms: Date.now() - t0 };
      const delay = 1500 * 2 ** i;
      logger.warn(`WhatsApp send not accepted (${c.reason}), retrying in ${delay}ms (attempt ${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return { ok: false, kind: 'retry', error: lastErr, ms: Date.now() - t0 };
}

function metaMediaReusable(work, chat, wantVoice) {
  if (!work?.metaMediaId || !work.metaMediaUploadedAt) return false;
  if (String(work.phoneNumberId || '') !== String(chat.phoneNumberId || '')) return false;
  if (Boolean(work.sentAsVoice) !== Boolean(wantVoice)) return false;
  return Date.now() - new Date(work.metaMediaUploadedAt).getTime() < META_MEDIA_REUSE_MS;
}

async function fileExists(p) {
  if (!p) return false;
  try {
    const st = await fs.promises.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/** Remove a persisted prepared file (only files inside the prepared folder). */
async function removePrepared(p) {
  if (!p) return;
  const dir = path.resolve(preparedDir());
  const abs = path.resolve(p);
  if (abs.startsWith(dir + path.sep)) await safeUnlink(abs);
}

/** Short user-facing error text (no tokens, no URLs with secrets). */
function userError(err) {
  const msg = String(err?.message || err || 'Unknown error');
  return msg.length > 300 ? `${msg.slice(0, 297)}...` : msg;
}

module.exports = {
  MEDIA_TYPES,
  prepareMedia,
  uploadToMeta,
  sendOnce,
  classifyMetaError,
  uploadWithRetry,
  metaMediaReusable,
  fileExists,
  removePrepared,
  preparedDir,
  userError,
  metaUploadSlots,
};
