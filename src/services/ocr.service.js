const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const axios = require('axios');
const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');
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
 * Upload a compressed image buffer to Cloudinary temporarily.
 * Returns the secure URL.
 */
async function uploadCompressedToCloudinary(compressedBuffer) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: 'whatsapp-bot/ocr-temp',
                resource_type: 'image',
                format: 'jpg',
                // Auto-delete after 1 hour to save storage
                invalidate: true,
            },
            (error, result) => {
                if (error) return reject(new Error(error.message));
                resolve(result.secure_url);
            }
        );
        streamifier.createReadStream(compressedBuffer).pipe(uploadStream);
    });
}

/**
 * Use OpenAI GPT-5 Nano (vision) to extract text/product codes from an image.
 * Sends the Cloudinary URL so the AI fetches a compressed image = fewer tokens.
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
                            'Just output the text.',
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
                                image_url: { url: imageUrl },
                            },
                        ],
                    },
                ],
                max_completion_tokens: 300,
                temperature: 1,
            },
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            }
        );

        const extractedText = response.data?.choices?.[0]?.message?.content?.trim() || '';
        logger.info(`OpenAI OCR extracted: "${extractedText}"`);
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
 *    - Compress image → upload to Cloudinary → send URL to OpenAI
 */
async function extractTextFromImageBuffer(buffer) {
    // ── Step 1: Try Tesseract first ──
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

        // If Tesseract got good results, return them
        // Reverting confidence to 40 so we fall back to the newly fixed OpenAI when Tesseract struggles
        if (bestText && bestConfidence >= 40) {
            logger.info(`Tesseract OCR succeeded (confidence: ${bestConfidence}): "${bestText.substring(0, 100)}"`);
            return { text: bestText, confidence: bestConfidence, source: 'tesseract' };
        }

        logger.info(`Tesseract OCR weak/empty (confidence: ${bestConfidence}), falling back to OpenAI...`);
    } catch (error) {
        logger.error(`Tesseract OCR failed: ${error.message}, falling back to OpenAI...`);
    }

    // ── Step 2: Fall back to OpenAI GPT-5 Nano ──
    try {
        // Compress the image to save OpenAI credits
        const compressedBuffer = await compressImageForAI(buffer);
        logger.info(`Image compressed for AI: ${buffer.length} → ${compressedBuffer.length} bytes (${Math.round((compressedBuffer.length / buffer.length) * 100)}%)`);

        // Upload compressed image to Cloudinary
        const imageUrl = await uploadCompressedToCloudinary(compressedBuffer);
        logger.info(`Compressed image uploaded to Cloudinary: ${imageUrl}`);

        // Send to OpenAI for text extraction
        const aiResult = await extractTextWithOpenAI(imageUrl);
        return aiResult;
    } catch (error) {
        logger.error(`OpenAI OCR fallback failed: ${error.message}`);
        return { text: '', confidence: 0 };
    }
}

module.exports = {
    extractTextFromImageBuffer,
};
