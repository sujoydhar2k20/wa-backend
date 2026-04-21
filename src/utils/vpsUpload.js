const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger } = require('./logger');

// Base directory where files are stored on the VPS
const UPLOAD_BASE_DIR = '/var/www/WhatsappUpload';
// Public URL base for the uploaded files
const UPLOAD_BASE_URL = 'https://upload.biswakarmagold.com';

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * Generate a unique filename using a timestamp + random hash.
 * Preserves the original extension if provided.
 */
function generateFilename(originalName, extension) {
    const timestamp = Date.now();
    const randomHash = crypto.randomBytes(8).toString('hex');
    const ext = extension || (originalName ? path.extname(originalName) : '');
    return `${timestamp}_${randomHash}${ext}`;
}

/**
 * Get the appropriate file extension from a mime type.
 */
function extensionFromMime(mimeType) {
    const map = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/svg+xml': '.svg',
        'video/mp4': '.mp4',
        'video/3gpp': '.3gp',
        'video/quicktime': '.mov',
        'audio/mpeg': '.mp3',
        'audio/mp4': '.mp4',
        'audio/ogg': '.ogg',
        'audio/aac': '.aac',
        'audio/amr': '.amr',
        'application/pdf': '.pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/msword': '.doc',
        'application/vnd.ms-excel': '.xls',
        'text/plain': '.txt',
        'text/csv': '.csv',
    };
    return map[mimeType] || '';
}

/**
 * Upload a buffer to the VPS filesystem.
 *
 * @param {Buffer} buffer - The file data to write.
 * @param {Object} options
 * @param {string} options.folder - Subfolder inside the upload directory (e.g. 'inbound', 'ocr-temp', 'uploads').
 * @param {string} [options.fileName] - Original file name (used for extension detection).
 * @param {string} [options.mimeType] - MIME type (fallback for extension detection).
 * @param {string} [options.extension] - Explicit extension override (e.g. '.jpg').
 * @param {string} [options.publicId] - If provided, used as the filename stem instead of random.
 * @returns {Promise<string>} The publicly accessible URL of the uploaded file.
 */
async function uploadToVPS(buffer, options = {}) {
    const { folder = 'general', fileName, mimeType, extension, publicId } = options;

    // Determine file extension
    let ext = extension || '';
    if (!ext && fileName) {
        ext = path.extname(fileName);
    }
    if (!ext && mimeType) {
        ext = extensionFromMime(mimeType);
    }

    // Build the target file name
    const targetName = publicId
        ? `${publicId}${ext}`
        : generateFilename(fileName, ext);

    // Build full directory and file path
    const targetDir = path.join(UPLOAD_BASE_DIR, folder);
    ensureDir(targetDir);

    const targetPath = path.join(targetDir, targetName);

    // Write the file
    await fs.promises.writeFile(targetPath, buffer);

    // Build public URL
    const publicUrl = `${UPLOAD_BASE_URL}/${folder}/${targetName}`;

    logger.info(`File uploaded to VPS: ${publicUrl} (${buffer.length} bytes)`);
    return publicUrl;
}

module.exports = {
    uploadToVPS,
    UPLOAD_BASE_DIR,
    UPLOAD_BASE_URL,
};
