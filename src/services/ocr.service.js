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
    try {
        // Upload the uncompressed image buffer directly to Cloudinary
        const imageUrl = await uploadCompressedToCloudinary(buffer);
        logger.info(`Uncompressed image uploaded to Cloudinary: ${imageUrl}`);
        
        logger.info('Sending image URL directly to OpenAI...');
        
        // Send directly to OpenAI without Tesseract or compression
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
