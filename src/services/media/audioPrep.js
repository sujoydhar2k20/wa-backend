'use strict';

/**
 * Audio rules are unchanged from the previous controller code (moved here so send, retry and the
 * background job share them), but work on files instead of whole in-memory buffers:
 *   recorded voice note -> OGG/OPUS mono 48 kHz (libopus), re-encoded at a lower bitrate above 512 KB;
 *                          if libopus is unavailable the caller sends an ordinary AAC/M4A audio file.
 *   any other audio     -> AAC/M4A 128k (always; browsers record WebM/MP4 variants Meta rejects).
 */
const fs = require('fs');
const { ffmpegSlots, run } = require('./videoPrep');
const { newTempPath, safeUnlink } = require('./source');

// WhatsApp shows the voice-message play icon only for OGG/OPUS files up to 512 KB.
const VOICE_PLAY_ICON_MAX_BYTES = 512 * 1024;

async function convertAudioFile(inputPath, outPath) {
  await ffmpegSlots.run(() => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath,
    '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'ipod', outPath], 60000));
  const st = await fs.promises.stat(outPath);
  if (!st.size) throw new Error('ffmpeg produced an empty audio output file');
  return { path: outPath, mimeType: 'audio/mp4', size: st.size };
}

async function convertVoiceFile(inputPath, outPath) {
  for (const bitrate of ['32k', '24k', '16k']) {
    await ffmpegSlots.run(() => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath,
      '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '48000',
      '-c:a', 'libopus', '-application', 'voip', '-b:a', bitrate, '-f', 'ogg', outPath], 60000));
    const fh = await fs.promises.open(outPath, 'r');
    let head;
    try {
      head = Buffer.alloc(200);
      const { bytesRead } = await fh.read(head, 0, 200, 0);
      head = head.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    const st = await fs.promises.stat(outPath);
    if (!st.size) throw new Error('ffmpeg produced an empty voice file');
    // "OggS" page header + "OpusHead": anything else is not a voice note Meta will accept.
    if (head.subarray(0, 4).toString('latin1') !== 'OggS' || !head.toString('latin1').includes('OpusHead')) {
      throw new Error('ffmpeg output is not Ogg/Opus');
    }
    if (st.size <= VOICE_PLAY_ICON_MAX_BYTES || bitrate === '16k') {
      return { path: outPath, mimeType: 'audio/ogg', size: st.size, oversize: st.size > VOICE_PLAY_ICON_MAX_BYTES, bitrate };
    }
  }
  throw new Error('unreachable');
}

/** Buffer wrapper kept for existing callers/tests: returns { buffer, oversize }. */
async function convertVoiceNoteForMeta(buffer) {
  const tmpIn = newTempPath('.in');
  const tmpOut = newTempPath('.ogg');
  try {
    await fs.promises.writeFile(tmpIn, buffer);
    const r = await convertVoiceFile(tmpIn, tmpOut);
    return { buffer: await fs.promises.readFile(tmpOut), oversize: r.oversize };
  } finally {
    await safeUnlink(tmpIn);
    await safeUnlink(tmpOut);
  }
}

module.exports = { convertAudioFile, convertVoiceFile, convertVoiceNoteForMeta, VOICE_PLAY_ICON_MAX_BYTES };
