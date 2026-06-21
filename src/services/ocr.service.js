const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const axios = require('axios');
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
 * Resizes to 400x500 and uses 60% JPEG quality.
 */
async function compressImageForAI(buffer) {
    return sharp(buffer)
        .rotate()
        .resize({ width: 400, height: 500 })
        .jpeg({ quality: 60 })
        .toBuffer();
}

/**
 * Use OpenAI GPT-5 Nano (vision) to extract text/product codes from an image.
 * Sends the image directly as a base64 data URL.
 */
async function extractTextWithOpenAI(imageBuffer, mimeType = 'image/jpeg') {
    if (!OPENAI_API_KEY) {
        logger.error('OPENAI_API_KEY is not set – cannot fall back to AI OCR');
        return { text: '', confidence: 0 };
    }

    try {
        const base64 = imageBuffer.toString('base64');
        const dataUrl = `data:${mimeType};base64,${base64}`;

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-5-nano',
                messages: [
                    {
                        role: 'system',
                        content:
                            'You are an OCR extraction model. Look carefully at the image and extract a product code. Valid code formats: S/number/number, D/number/number, or number/number. If the code starts with BJS or CODE, remove those prefixes and return only the code. Respond only with the code. If no valid code exists, respond with NONE.',
                    },
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'image_url',
                                image_url: { url: dataUrl, detail: 'high' },
                            },
                        ],
                    },
                ],
            },
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        logger.info(`OpenAI Full Choice: ${JSON.stringify(response.data?.choices?.[0])}`);
        const extractedText = response.data?.choices?.[0]?.message?.content?.trim() || '';
        logger.info(`OpenAI OCR extracted: "${extractedText}"`);
        
           if (extractedText === 'NONE') {
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
 *    - Compress image → send directly to OpenAI
 */
async function extractTextFromImageBuffer(buffer) {
    try {
        // Compress locally first to limit size (saves tokens)
        const compressedBuffer = await compressImageForAI(buffer);
        logger.info('Sending image directly to OpenAI...');
        
        // Send directly to OpenAI without Tesseract
        const aiResult = await extractTextWithOpenAI(compressedBuffer);
        return aiResult;
    } catch (error) {
        logger.error(`Direct OpenAI OCR failed: ${error.message}`);
        return { text: '', confidence: 0 };
    }
}

module.exports = {
    extractTextFromImageBuffer,
};
