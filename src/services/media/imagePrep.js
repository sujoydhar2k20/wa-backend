'use strict';

/**
 * One rule set for every outgoing photo (normal send, retry, background job, bulk product send).
 *
 * Pass-through (no decode/re-encode) when ALL hold:
 *   real JPEG or PNG (magic bytes), <= 5 MB, longest edge <= 2048 px, 8-bit sRGB/RGB(A),
 *   no EXIF rotation needed (orientation missing or 1), single frame.
 * Otherwise: auto-orient (EXIF), resize to <= 2048 px, then
 *   - images that really use transparency stay PNG (palette-quantised / smaller if needed to fit 5 MB)
 *   - everything else becomes JPEG quality 80 (lower / smaller only if still over 5 MB)
 * The output is re-read and validated before it is handed to Meta.
 */
const fs = require('fs');
const sharp = require('sharp');
const { META_LIMITS, IMAGE_MAX_EDGE, IMAGE_JPEG_QUALITY, CONCURRENCY } = require('./limits');
const { Semaphore } = require('./semaphore');
const { sniffFile } = require('./sniff');

const imageSlots = new Semaphore(CONCURRENCY.image, 'image');

class ImagePrepError extends Error {
  constructor(message, code = 'IMAGE_INVALID') {
    super(message);
    this.code = code;
    this.permanent = true;
  }
}

async function readMetadata(filePath) {
  try {
    return await sharp(filePath).metadata();
  } catch (e) {
    throw new ImagePrepError('This image file is damaged or in a format that cannot be read.', 'IMAGE_UNREADABLE');
  }
}

/** Decide without touching pixels. Returns { passThrough, reasons[], meta, sniffed, size }. */
async function inspectImage(filePath) {
  const [st, sniffed] = await Promise.all([fs.promises.stat(filePath), sniffFile(filePath)]);
  if (sniffed === 'image/heic' || sniffed === 'image/avif') {
    // sharp's prebuilt binaries cannot decode HEIC; fail clearly instead of sending garbage.
    if (sniffed === 'image/heic') {
      throw new ImagePrepError('HEIC photos are not supported here. Please send the photo as JPEG.', 'IMAGE_HEIC');
    }
  }
  const meta = await readMetadata(filePath);
  const reasons = [];
  const fmt = meta.format;
  const sniffOk = (sniffed === 'image/jpeg' && fmt === 'jpeg') || (sniffed === 'image/png' && fmt === 'png');
  if (!sniffOk) reasons.push(`format:${sniffed || fmt || 'unknown'}`);
  if (st.size > META_LIMITS.image) reasons.push('size');
  if (Math.max(meta.width || 0, meta.height || 0) > IMAGE_MAX_EDGE) reasons.push('dimensions');
  if (meta.orientation && meta.orientation !== 1) reasons.push('orientation');
  if (meta.depth && meta.depth !== 'uchar') reasons.push(`depth:${meta.depth}`);
  if (meta.space && meta.space !== 'srgb') reasons.push(`colour:${meta.space}`);
  if (meta.channels && ![3, 4].includes(meta.channels)) reasons.push(`channels:${meta.channels}`);
  if (fmt === 'jpeg' && meta.channels === 4) reasons.push('jpeg-alpha/cmyk');
  if ((meta.pages || 1) > 1) reasons.push('animated');
  return { passThrough: reasons.length === 0, reasons, meta, sniffed, size: st.size };
}

async function encode(input, { edge, asPng, quality, palette }) {
  let p = sharp(input, { failOn: 'error' })
    .rotate() // honour EXIF orientation, then strip it
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .toColorspace('srgb');
  if (asPng) {
    p = p.png(palette ? { palette: true, quality: 90, compressionLevel: 9 } : { compressionLevel: 9, adaptiveFiltering: true });
  } else {
    p = p.flatten({ background: '#ffffff' }).jpeg({ quality, chromaSubsampling: '4:2:0' });
  }
  return p.toBuffer({ resolveWithObject: true });
}

/**
 * Prepare an image for Meta. Writes to `outPath` only when a transform is needed.
 * Returns { path, mimeType, size, action: 'passthrough'|'transformed', width, height, reasons, ms }.
 */
async function prepareImage(inputPath, outPath) {
  const t0 = Date.now();
  const info = await inspectImage(inputPath);
  if (info.passThrough) {
    return {
      path: inputPath,
      mimeType: info.sniffed,
      size: info.size,
      action: 'passthrough',
      width: info.meta.width,
      height: info.meta.height,
      reasons: [],
      ms: Date.now() - t0,
    };
  }

  return imageSlots.run(async () => {
    let usesAlpha = false;
    if (info.meta.hasAlpha) {
      try {
        const stats = await sharp(inputPath, { failOn: 'error' }).stats();
        usesAlpha = !stats.isOpaque;
      } catch {
        throw new ImagePrepError('This image file is damaged or in a format that cannot be read.', 'IMAGE_UNREADABLE');
      }
    }
    const attempts = usesAlpha
      ? [
        { edge: IMAGE_MAX_EDGE, asPng: true },
        { edge: IMAGE_MAX_EDGE, asPng: true, palette: true },
        { edge: 1600, asPng: true, palette: true },
        { edge: 1280, asPng: true, palette: true },
      ]
      : [
        { edge: IMAGE_MAX_EDGE, quality: IMAGE_JPEG_QUALITY },
        { edge: IMAGE_MAX_EDGE, quality: 70 },
        { edge: 1600, quality: 70 },
        { edge: 1280, quality: 65 },
      ];
    let out;
    for (const a of attempts) {
      try {
        out = await encode(inputPath, a);
      } catch (e) {
        throw new ImagePrepError('This image file is damaged or in a format that cannot be read.', 'IMAGE_UNREADABLE');
      }
      if (out.data.length <= META_LIMITS.image) break;
    }
    if (out.data.length > META_LIMITS.image) {
      throw new ImagePrepError('The photo is still larger than WhatsApp allows (5 MB) after compression.', 'IMAGE_TOO_LARGE');
    }
    await fs.promises.writeFile(outPath, out.data);
    // Validate what we produced before it goes to Meta.
    const check = await sharp(outPath).metadata();
    const okFormat = usesAlpha ? check.format === 'png' : check.format === 'jpeg';
    if (!okFormat || Math.max(check.width, check.height) > IMAGE_MAX_EDGE || check.depth !== 'uchar') {
      throw new ImagePrepError('Image preparation produced an invalid file.', 'IMAGE_OUTPUT_INVALID');
    }
    return {
      path: outPath,
      mimeType: usesAlpha ? 'image/png' : 'image/jpeg',
      size: out.data.length,
      action: 'transformed',
      width: check.width,
      height: check.height,
      reasons: info.reasons,
      ms: Date.now() - t0,
    };
  });
}

module.exports = { prepareImage, inspectImage, ImagePrepError, imageSlots };
