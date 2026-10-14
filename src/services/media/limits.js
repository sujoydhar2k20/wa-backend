'use strict';

/**
 * WhatsApp Cloud API media rules (Meta "Supported media types", checked 14 Oct 2026):
 *   image    JPEG / PNG, 8-bit RGB or RGBA, max 5 MB
 *   video    MP4 / 3GPP, H.264 video + AAC audio (one audio stream or none), max 16 MB
 *   audio    AAC, AMR, MP3, M4A, OGG (Opus, mono), max 16 MB
 *   document max 100 MB
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
 */
const MB = 1024 * 1024;

const META_LIMITS = {
  image: 5 * MB,
  video: 16 * MB,
  audio: 16 * MB,
  document: 100 * MB,
};

/** Longest edge a photo may have before we resize it (keeps uploads to Meta small; WhatsApp shows ~1600 px). */
const IMAGE_MAX_EDGE = 2048;
/** JPEG quality used only when an image must be re-encoded. */
const IMAGE_JPEG_QUALITY = 80;
/** Longest video edge (720p class) when a video has to be transcoded. */
const VIDEO_MAX_HEIGHT = 720;

function int(name, fallback, min = 1) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= min ? v : fallback;
}

/** Concurrency limits for this Node process (tune after measuring the VPS; see docs/MEDIA_PIPELINE.md). */
const CONCURRENCY = {
  ffmpeg: int('MEDIA_FFMPEG_CONCURRENCY', 1),          // video/audio conversions at once
  image: int('MEDIA_IMAGE_CONCURRENCY', 2),            // sharp transforms at once
  metaUpload: int('MEDIA_META_UPLOAD_CONCURRENCY', 3), // uploads to graph.facebook.com at once
  jobs: int('MEDIA_JOB_CONCURRENCY', 4),               // background media jobs at once
};

/** Back-pressure: refuse new async media sends (503, retryable) above this many unfinished ones. */
const MAX_PENDING_MEDIA = int('MEDIA_MAX_PENDING', 200);

/** Timeouts (ms). Separate policies for each network leg. */
const TIMEOUTS = {
  externalFetch: int('MEDIA_FETCH_TIMEOUT_MS', 60000),     // downloading a non-local mediaUrl
  metaUpload: int('META_UPLOAD_TIMEOUT_MS', 180000),       // POST /{phone}/media (up to 100 MB documents)
  metaSend: int('META_SEND_TIMEOUT_MS', 30000),            // POST /{phone}/messages
  ffmpegVideo: int('MEDIA_FFMPEG_VIDEO_TIMEOUT_MS', 300000),
  ffmpegRemux: int('MEDIA_FFMPEG_REMUX_TIMEOUT_MS', 60000),
  ffprobe: int('MEDIA_FFPROBE_TIMEOUT_MS', 20000),
};

/** Meta keeps uploaded media for 30 days; reuse an uploaded media id for retries well inside that. */
const META_MEDIA_REUSE_MS = 25 * 24 * 3600 * 1000;

module.exports = {
  MB, META_LIMITS, IMAGE_MAX_EDGE, IMAGE_JPEG_QUALITY, VIDEO_MAX_HEIGHT,
  CONCURRENCY, MAX_PENDING_MEDIA, TIMEOUTS, META_MEDIA_REUSE_MS,
};
