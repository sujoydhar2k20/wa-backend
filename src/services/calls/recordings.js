'use strict';

/**
 * Call recordings: Asterisk writes WAV files (MixMonitor) under CALL_RECORDINGS_DIR; after the call the
 * backend converts them to small AAC/M4A files, links them to the CallLog and deletes the WAV.
 * Files are served only through short-lived signed links (see signToken/verifyToken).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const CallLog = require('../../models/CallLog');
const { logger } = require('../../utils/logger');
const callingConfig = require('./config');

const safeRelative = (rel) => {
  const n = path.normalize(String(rel || '')).replace(/^([/\\])+/, '');
  if (!n || n.startsWith('..') || path.isAbsolute(n) || !/^[\w./-]+$/.test(n)) return null;
  return n;
};
const abs = (rel) => path.join(callingConfig.get().recordingsDir, rel);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForStableFile(file, tries = 10) {
  let last = -1;
  for (let i = 0; i < tries; i++) {
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      if (size > 44 && size === last) return size;
      last = size;
    }
    await sleep(1000);
  }
  return fs.existsSync(file) ? fs.statSync(file).size : 0;
}

function ffmpeg(args) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    p.on('error', (e) => resolve({ ok: false, err: e.message }));
    p.on('close', (code) => resolve({ ok: code === 0, err }));
  });
}

/** Convert one call's WAV to M4A and attach it to the CallLog. Never throws. */
async function processRecording(callLogId, relWav) {
  const rel = safeRelative(relWav);
  if (!rel) return;
  try {
    await CallLog.updateOne({ _id: callLogId }, { $set: { 'recording.status': 'pending', 'recording.path': rel } });
    const wav = abs(rel);
    const size = await waitForStableFile(wav);
    if (!size) {
      await CallLog.updateOne({ _id: callLogId }, { $set: { 'recording.status': 'none' }, $unset: { 'recording.path': '' } });
      return;
    }
    // MP3 plays in every browser (Chrome/Chromium builds without AAC, Firefox on Linux, iOS Safari).
    // If this ffmpeg has no MP3 encoder, fall back to AAC (.m4a).
    let relOut = rel.replace(/\.wav$/i, '.mp3');
    let out = abs(relOut);
    let r = await ffmpeg(['-y', '-loglevel', 'error', '-i', wav, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k', out]);
    if (!r.ok) {
      try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch (_) { /* ignore */ }
      relOut = rel.replace(/\.wav$/i, '.m4a');
      out = abs(relOut);
      r = await ffmpeg(['-y', '-loglevel', 'error', '-i', wav, '-ac', '1', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart', out]);
    }
    if (!r.ok) {
      logger.warn(`[calls] recording conversion failed for ${callLogId}, keeping WAV: ${r.err.trim().slice(-300)}`);
      await CallLog.updateOne({ _id: callLogId }, { $set: { 'recording.status': 'ready', 'recording.sizeBytes': size } });
      return;
    }
    const outSize = fs.statSync(out).size;
    fs.unlinkSync(wav);
    const durationSec = Math.round((size - 44) / 16000); // 8 kHz 16-bit mono WAV from MixMonitor
    await CallLog.updateOne({ _id: callLogId }, {
      $set: { 'recording.status': 'ready', 'recording.path': relOut, 'recording.sizeBytes': outSize, 'recording.durationSec': durationSec },
    });
    logger.info(`[calls] recording ready for ${callLogId}: ${relOut} (${Math.round(outSize / 1024)} KB)`);
  } catch (e) {
    logger.error(`[calls] recording processing error for ${callLogId}: ${e.message}`);
    await CallLog.updateOne({ _id: callLogId }, { $set: { 'recording.status': 'failed' } }).catch(() => {});
  }
}

/** Unanswered calls leave an empty WAV (header only) from MixMonitor: remove it. */
async function discardRecording(relWav) {
  const rel = safeRelative(relWav);
  if (!rel) return;
  const f = abs(rel);
  await sleep(1500);
  try { if (fs.existsSync(f) && fs.statSync(f).size <= 1024) fs.unlinkSync(f); } catch (_) { /* ignore */ }
}

// ---- signed playback links (an <audio> tag cannot send the Authorization header) ----
const secret = () => crypto.createHash('sha256').update(`bjs-rec-v1:${process.env.JWT_SECRET || ''}`).digest();
function signToken(callLogId, userId, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = `${callLogId}.${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${Buffer.from(body).toString('base64url')}.${sig}`;
}
function verifyToken(token, callLogId) {
  const [b, sig] = String(token || '').split('.');
  if (!b || !sig) return null;
  const body = Buffer.from(b, 'base64url').toString();
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [id, userId, exp] = body.split('.');
  if (id !== String(callLogId) || Number(exp) < Date.now() / 1000) return null;
  return { userId };
}

function resolveFile(rel) {
  const r = safeRelative(rel);
  if (!r) return null;
  const f = abs(r);
  return fs.existsSync(f) ? f : null;
}

/** Delete call logs and recordings older than the retention period, and orphan WAVs. */
async function cleanupOld() {
  const cfg = callingConfig.get();
  const cutoff = new Date(Date.now() - cfg.recordingRetentionDays * 24 * 3600e3);
  let files = 0;
  const old = await CallLog.find({ createdAt: { $lt: cutoff } }).select('recording').lean();
  for (const c of old) {
    const f = c.recording?.path && resolveFile(c.recording.path);
    if (f) { try { fs.unlinkSync(f); files++; } catch (_) { /* ignore */ } }
  }
  const { deletedCount } = await CallLog.deleteMany({ createdAt: { $lt: cutoff } });
  // Orphans: files older than the retention period anywhere under the recordings dir
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); try { if (!fs.readdirSync(p).length) fs.rmdirSync(p); } catch (_) { /* ignore */ } } else if (fs.statSync(p).mtime < cutoff) { try { fs.unlinkSync(p); files++; } catch (_) { /* ignore */ } }
    }
  };
  walk(cfg.recordingsDir);
  if (deletedCount || files) logger.info(`[calls] retention cleanup: ${deletedCount} call logs, ${files} files removed`);
  return { deletedCount, files };
}

module.exports = { processRecording, discardRecording, signToken, verifyToken, resolveFile, cleanupOld, safeRelative };
