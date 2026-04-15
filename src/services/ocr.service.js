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

        const attempts = [
            { tessedit_pageseg_mode: Tesseract.PSM.AUTO },
            { tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK },
            {
                tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/-_ ',
            },
        ];

        let bestText = '';
        let bestConfidence = 0;

        for (const params of attempts) {
            const result = await Tesseract.recognize(preprocessed, 'eng', params);
            const text = (result?.data?.text || '').trim();
            const confidence = Number(result?.data?.confidence || 0);
            if (text && confidence >= bestConfidence) {
                bestText = text;
                bestConfidence = confidence;
            }
        }

        return { text: bestText, confidence: bestConfidence };
    } catch (error) {
        logger.error(`OCR extraction failed: ${error.message}`);
        return { text: '', confidence: 0 };
    }
}

module.exports = {
    extractTextFromImageBuffer,
};
