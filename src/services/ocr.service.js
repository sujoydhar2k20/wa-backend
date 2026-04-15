const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const { logger } = require('../utils/logger');

/**
 * OCR works much better on high-contrast, denoised images.
 * Preprocess before passing to Tesseract.
 */
async function preprocessImageForOcr(buffer) {
    return sharp(buffer)
        .rotate() // auto-orient using EXIF metadata
        .grayscale()
        .normalize()
        .sharpen()
        .resize({ width: 1600, withoutEnlargement: true })
        .png()
        .toBuffer();
}

async function extractTextFromImageBuffer(buffer) {
    try {
        const preprocessed = await preprocessImageForOcr(buffer);
        const result = await Tesseract.recognize(preprocessed, 'eng', {
            tessedit_pageseg_mode: Tesseract.PSM.AUTO,
        });

        const text = (result?.data?.text || '').trim();
        const confidence = Number(result?.data?.confidence || 0);
        return { text, confidence };
    } catch (error) {
        logger.error(`OCR extraction failed: ${error.message}`);
        return { text: '', confidence: 0 };
    }
}

module.exports = {
    extractTextFromImageBuffer,
};
