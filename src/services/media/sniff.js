'use strict';

const fs = require('fs');

/** Read the first `n` bytes of a file (never the whole file). */
async function readHead(filePath, n = 64) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * MIME type from magic bytes. Returns null when unknown. Extensions and HTTP headers are not trusted.
 */
function sniffMime(head) {
  if (!head || head.length < 4) return null;
  const b = head;
  const ascii = (start, end) => b.subarray(start, end).toString('latin1');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (/^hei[cxsm]|^mif1|^msf1|^hevc/.test(brand)) return 'image/heic';
    if (/^avif/.test(brand)) return 'image/avif';
    if (/^3g/.test(brand)) return 'video/3gpp';
    if (brand === 'qt  ') return 'video/quicktime';
    if (/^M4A /.test(brand)) return 'audio/mp4';
    return 'video/mp4';
  }
  if (ascii(0, 4) === '%PDF') return 'application/pdf';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'application/zip';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'application/x-ole-storage';
  if (ascii(0, 4) === 'Rar!') return 'application/vnd.rar';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(0, 5) === '#!AMR') return 'audio/amr';
  return null;
}

async function sniffFile(filePath) {
  return sniffMime(await readHead(filePath, 64));
}

module.exports = { readHead, sniffMime, sniffFile };
