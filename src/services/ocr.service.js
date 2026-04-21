const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const axios = require('axios');
const { uploadToVPS } = require('../utils/vpsUpload');
const { logger } = require('../utils/logger');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

/**
 * Compress the image to a small JPEG for sending to OpenAI (saves credits).
 * Resizes to max 800px wide and uses 60% JPEG quality.
 */
async function compressImageForAI(buffer) {
    return sharp(buffer)
        .rotate()
        .resize({ width: 800, withoutEnlargement: true })
        .jpeg({ quality: 60 })
        .toBuffer();
}

/**
 * Upload a compressed image buffer to the VPS temporarily.
 * Returns the public URL.
 */
async function uploadCompressedToVPS(compressedBuffer) {
    return uploadToVPS(compressedBuffer, {
        folder: 'ocr-temp',
        mimeType: 'image/jpeg',
    });
}

/**
 * Use OpenAI GPT-5 Nano (vision) to extract text/product codes from an image.
 * Sends the VPS URL so the AI fetches a compressed image = fewer tokens.
 */
async function extractTextWithOpenAI(imageUrl) {
    if (!OPENAI_API_KEY) {
        logger.error('OPENAI_API_KEY is not set – cannot fall back to AI OCR');
        return { text: '', confidence: 0 };
    }

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-5-nano',
                messages: [
                    {
                        role: 'system',
                        content:
                            'You are an OCR assistant. Please extract all the text you can see in this image. ' +
                            'Pay special attention to product codes, SKU numbers, or model numbers (e.g., "BJS 20/112", "138/3"). ' +
                            'Just output the text. If you cannot find any text, please output: [NO TEXT VISIBLE].',
                    },
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: 'What text is visible in this image?',
                            },
                            {
                                type: 'image_url',
                                image_url: { url: imageUrl, detail: 'high' },
                            },
                        ],
                    },
                ],
                max_completion_tokens: 2000,
            },
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            }
        );

        logger.info(`OpenAI Full Choice: ${JSON.stringify(response.data?.choices?.[0])}`);
        const extractedText = response.data?.choices?.[0]?.message?.content?.trim() || '';
        logger.info(`OpenAI OCR extracted: "${extractedText}"`);
        
        if (extractedText === '[NO TEXT VISIBLE]') {
             return { text: '', confidence: 0 };
        }
        
        return { text: extractedText, confidence: 85, source: 'openai' };
    } catch (error) {
        logger.error(`OpenAI OCR failed: ${error.response?.data?.error?.message || error.message}`);
        return { text: '', confidence: 0 };
    }
}

/**
 * Main OCR function:
 * 1. Try Tesseract (fast, free, local)
 * 2. If Tesseract fails (no text or low confidence), fall back to OpenAI GPT-5 Nano
 *    - Compress image → upload to VPS → send URL to OpenAI
 */
async function extractTextFromImageBuffer(buffer) {
    try {
        // Pass the raw image buffer to VPS for OCR processing
        const imageUrl = await uploadCompressedToVPS(buffer);
        logger.info(`VPS-uploaded image for OCR: ${imageUrl}`);
        
        logger.info('Sending image URL directly to OpenAI...');
        
        // Send directly to OpenAI without Tesseract
        const aiResult = await extractTextWithOpenAI(imageUrl);
        return aiResult;
    } catch (error) {
        logger.error(`Direct OpenAI OCR failed: ${error.message}`);
        return { text: '', confidence: 0 };
    }
}

module.exports = {
    extractTextFromImageBuffer,
};
