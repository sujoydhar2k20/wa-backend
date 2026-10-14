'use strict';

/**
 * One decision process for every outgoing video (normal send, retry, background job, bulk).
 *
 *   ffprobe the file (codecs, pixel format, streams, duration, size; the extension is never trusted)
 *   passthrough  H.264 (8-bit 4:2:0) + AAC/no audio, MP4 container, only those streams, <= 16 MB
 *   remux        same codecs but QuickTime/.mov/3GP container or extra data/subtitle/audio streams
 *                -> stream copy (-c copy), no re-encode
 *   audio        H.264 video is fine but audio is not AAC -> copy video, re-encode audio only
 *   transcode    any other codec (HEVC, VP9, AV1, 10-bit...) or over 16 MB
 *                -> H.264 veryfast, short edge <= 720 px (aspect kept), bitrate capped to fit 16 MB
 * Every output is probed again and must pass the same compatibility + size check before Meta sees it.
 * ffmpeg/ffprobe get argument arrays (execFile, no shell) and run under a concurrency limit.
 */
const fs = require('fs');
const { execFile } = require('child_process');
const { META_LIMITS, VIDEO_MAX_HEIGHT, CONCURRENCY, TIMEOUTS } = require('./limits');
const { Semaphore } = require('./semaphore');
const { sniffFile } = require('./sniff');

const ffmpegSlots = new Semaphore(CONCURRENCY.ffmpeg, 'ffmpeg');

class VideoPrepError extends Error {
  constructor(message, code = 'VIDEO_INVALID') {
    super(message);
    this.code = code;
    this.permanent = true;
  }
}

function run(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`${bin} failed: ${err.killed ? 'timed out' : err.message} ${String(stderr || '').slice(-400)}`);
        e.timedOut = Boolean(err.killed);
        e.missingBinary = err.code === 'ENOENT';
        reject(e);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function probe(filePath) {
  let out;
  try {
    out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], TIMEOUTS.ffprobe);
  } catch (e) {
    if (e.missingBinary) {
      // Server setup problem, not a bad file: say so (and allow a retry once ffprobe is installed).
      const err = new VideoPrepError('Video check tool (ffprobe) is not installed on the server.', 'FFPROBE_MISSING');
      err.permanent = false;
      throw err;
    }
    throw new VideoPrepError('This video file is damaged or in a format that cannot be read.', 'VIDEO_UNREADABLE');
  }
  let json;
  try {
    json = JSON.parse(out.stdout);
  } catch {
    throw new VideoPrepError('This video file could not be inspected.', 'VIDEO_UNREADABLE');
  }
  const streams = json.streams || [];
  const video = streams.filter((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const other = streams.filter((s) => !video.includes(s) && !audio.includes(s));
  const v = video[0];
  const duration = Number(json.format?.duration) || Number(v?.duration) || null;
  return {
    formatName: json.format?.format_name || '',
    duration,
    size: Number(json.format?.size) || null,
    video: v ? {
      codec: v.codec_name,
      profile: v.profile || '',
      pixFmt: v.pix_fmt || '',
      width: v.width,
      height: v.height,
    } : null,
    videoCount: video.length,
    audio: audio.map((a) => ({ codec: a.codec_name, channels: a.channels })),
    otherCount: other.length,
  };
}

const OK_PIX = new Set(['yuv420p', 'yuvj420p']);

function videoCodecOk(info) {
  const v = info.video;
  if (!v) return false;
  if (v.codec !== 'h264') return false;
  if (!OK_PIX.has(v.pixFmt)) return false;
  return !/10|4:2:2|4:4:4/.test(v.profile);
}

function audioCodecOk(info) {
  return info.audio.length === 0 || info.audio[0].codec === 'aac';
}

function containerOk(sniffed) {
  // MP4 only: 3GP/QuickTime files with the right codecs are re-packaged (stream copy, no re-encode).
  return sniffed === 'video/mp4';
}

/** Pure decision (exported for tests). */
function decide({ info, sniffed, size }) {
  if (!info.video) return { action: 'reject', reasons: ['no-video-stream'] };
  const reasons = [];
  const vOk = videoCodecOk(info);
  const aOk = audioCodecOk(info);
  if (!vOk) reasons.push(`video:${info.video.codec}/${info.video.pixFmt}${info.video.profile ? `/${info.video.profile}` : ''}`);
  if (!aOk) reasons.push(`audio:${info.audio[0].codec}`);
  if (size > META_LIMITS.video) reasons.push('size');
  if (!vOk || size > META_LIMITS.video) return { action: 'transcode', reasons };
  if (!aOk) return { action: 'audio', reasons };
  const clean = info.videoCount === 1 && info.audio.length <= 1 && info.otherCount === 0;
  if (!containerOk(sniffed)) reasons.push(`container:${sniffed || 'unknown'}`);
  if (!clean) reasons.push('extra-streams');
  if (!containerOk(sniffed) || !clean) return { action: 'remux', reasons };
  return { action: 'passthrough', reasons };
}

function scaleFilter(maxShort) {
  // Short edge <= maxShort, aspect ratio kept, even dimensions, never upscaled. (ffmpeg auto-rotates first.)
  return `scale='if(gte(iw,ih),-2,min(${maxShort},iw))':'if(gte(iw,ih),min(${maxShort},ih),-2)'`;
}

function transcodeArgs(input, output, info, { maxShort, videoKbps }) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1',
    '-vf', scaleFilter(maxShort),
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
  if (videoKbps) {
    args.push('-crf', '23', '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`);
  } else {
    args.push('-crf', '26');
  }
  if (info.audio.length) args.push('-c:a', 'aac', '-b:a', '96k', '-ac', '2');
  else args.push('-an');
  args.push('-movflags', '+faststart', '-f', 'mp4', output);
  return args;
}

/** Video bitrate (kbit/s) that keeps `duration` seconds inside ~15 MB with 96k audio; capped for 720p. */
function budgetKbps(duration, hasAudio, ceiling = 2500) {
  if (!duration || duration <= 0) return ceiling;
  const totalKbits = (15 * 1024 * 1024 * 8) / 1000;
  const v = Math.floor(totalKbits / duration - (hasAudio ? 96 : 0) - 32); // 32k container overhead margin
  return Math.max(150, Math.min(ceiling, v));
}

async function validateOutput(outPath) {
  const st = await fs.promises.stat(outPath).catch(() => null);
  if (!st || st.size === 0) throw new VideoPrepError('Video conversion produced no output.', 'VIDEO_OUTPUT_INVALID');
  const info = await probe(outPath);
  const sniffed = await sniffFile(outPath);
  if (!videoCodecOk(info) || !audioCodecOk(info) || !containerOk(sniffed) || info.audio.length > 1) {
    throw new VideoPrepError('Video conversion produced an incompatible file.', 'VIDEO_OUTPUT_INVALID');
  }
  return { info, size: st.size };
}

/**
 * Prepare a video for Meta. Returns
 * { path, mimeType:'video/mp4', size, action, reasons, ms, probeMs, convertMs, width, height, duration }.
 */
async function prepareVideo(inputPath, outPath) {
  const t0 = Date.now();
  const st = await fs.promises.stat(inputPath);
  const sniffed = await sniffFile(inputPath);
  const info = await probe(inputPath);
  const probeMs = Date.now() - t0;
  const d = decide({ info, sniffed, size: st.size });
  if (d.action === 'reject') throw new VideoPrepError('This file has no video track.', 'VIDEO_NO_STREAM');

  const base = { reasons: d.reasons, probeMs, duration: info.duration, width: info.video.width, height: info.video.height };
  if (d.action === 'passthrough') {
    return { ...base, path: inputPath, mimeType: sniffed, size: st.size, action: 'passthrough', convertMs: 0, ms: Date.now() - t0 };
  }

  const tc = Date.now();
  await ffmpegSlots.run(async () => {
    if (d.action === 'remux') {
      await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath,
        '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', outPath], TIMEOUTS.ffmpegRemux);
      return;
    }
    if (d.action === 'audio') {
      await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath,
        '-map', '0:v:0', '-map', '0:a:0', '-sn', '-dn', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
        '-movflags', '+faststart', '-f', 'mp4', outPath], TIMEOUTS.ffmpegVideo);
      return;
    }
    // transcode
    const hasAudio = info.audio.length > 0;
    await run('ffmpeg', transcodeArgs(inputPath, outPath, info, {
      maxShort: VIDEO_MAX_HEIGHT,
      videoKbps: budgetKbps(info.duration, hasAudio),
    }), TIMEOUTS.ffmpegVideo);
    let size = (await fs.promises.stat(outPath)).size;
    if (size > META_LIMITS.video) {
      // Long video: one more pass at a lower resolution and a stricter bitrate.
      await run('ffmpeg', transcodeArgs(inputPath, outPath, info, {
        maxShort: 480,
        videoKbps: Math.floor(budgetKbps(info.duration, hasAudio) * 0.8),
      }), TIMEOUTS.ffmpegVideo);
      size = (await fs.promises.stat(outPath)).size;
    }
  }).catch((e) => {
    if (e instanceof VideoPrepError) throw e;
    const err = new VideoPrepError(e.timedOut
      ? 'Video conversion took too long and was stopped.'
      : 'This video could not be converted for WhatsApp.', e.timedOut ? 'VIDEO_TIMEOUT' : 'VIDEO_CONVERT_FAILED');
    err.permanent = !e.timedOut; // a timeout may succeed when the server is less busy
    err.detail = e.message;
    throw err;
  });
  const convertMs = Date.now() - tc;
  const { info: outInfo, size } = await validateOutput(outPath);
  if (size > META_LIMITS.video) {
    throw new VideoPrepError('This video is too long to fit WhatsApp\'s 16 MB limit even after compression.', 'VIDEO_TOO_LARGE');
  }
  return {
    ...base,
    path: outPath,
    mimeType: 'video/mp4',
    size,
    action: d.action,
    convertMs,
    width: outInfo.video.width,
    height: outInfo.video.height,
    ms: Date.now() - t0,
  };
}

module.exports = { prepareVideo, probe, decide, budgetKbps, VideoPrepError, ffmpegSlots, run };
