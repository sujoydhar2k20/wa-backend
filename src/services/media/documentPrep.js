'use strict';

/**
 * Documents are never modified; only the MIME type sent to Meta is corrected from the file's magic bytes
 * (servers and extensions often lie, and Meta rejects a declared type that does not match the content).
 */
const fs = require('fs');
const path = require('path');
const { readHead } = require('./sniff');
const { META_LIMITS } = require('./limits');

const EXT_MIME = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.rtf': 'application/rtf',
  '.zip': 'application/zip',
};

/** Same rules as the previous controller code (magic bytes win; ZIP/OLE family decided by the declared type). */
function detectDocumentMimeType(buffer, fallback) {
  fallback = fallback || 'application/octet-stream';
  if (buffer.length < 8) return fallback;
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
  if (buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04) {
    if (fallback.includes('word') || fallback.includes('docx') || fallback.includes('doc')) {
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    if (fallback.includes('sheet') || fallback.includes('xlsx') || fallback.includes('xls')) {
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    if (fallback.includes('presentation') || fallback.includes('pptx') || fallback.includes('ppt')) {
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    }
    return 'application/zip';
  }
  if (buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0) {
    if (fallback.includes('xls')) return 'application/vnd.ms-excel';
    if (fallback.includes('ppt')) return 'application/vnd.ms-powerpoint';
    return 'application/msword';
  }
  if (buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72 && buffer[3] === 0x21) return 'application/vnd.rar';
  return fallback;
}

class DocumentPrepError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.permanent = true;
  }
}

/** `hintMime`: header/known type; `nameHint`: file name or URL used for the extension fallback. */
async function prepareDocument(filePath, { hintMime, nameHint } = {}) {
  const st = await fs.promises.stat(filePath);
  if (st.size > META_LIMITS.document) {
    throw new DocumentPrepError('The document is larger than WhatsApp allows (100 MB).', 'DOCUMENT_TOO_LARGE');
  }
  const ext = path.extname(String(nameHint || filePath).split('?')[0]).toLowerCase();
  const fallback = (hintMime && hintMime !== 'application/octet-stream' ? hintMime : null) || EXT_MIME[ext] || hintMime || 'application/octet-stream';
  const mimeType = detectDocumentMimeType(await readHead(filePath, 16), fallback);
  return { path: filePath, mimeType, size: st.size, action: 'passthrough', reasons: [], ms: 0 };
}

module.exports = { prepareDocument, detectDocumentMimeType, EXT_MIME };
