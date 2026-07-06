const axios = require('axios');
const { logger } = require('../utils/logger');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PRIMARY_OPENAI_MODEL = process.env.OPENAI_MESSAGE_IMPROVEMENT_MODEL || 'gpt-5-nano';
const FALLBACK_OPENAI_MODEL = process.env.OPENAI_MESSAGE_IMPROVEMENT_FALLBACK_MODEL || 'gpt-4o';

/**
 * System prompt for improving staff messages
 */
const SYSTEM_PROMPT = `Understand the entire message first and identify whether it is English, Hinglish, or Bengalish.

Use only one language style in the output. Do not mix English, Hindi, and Bengali in the same sentence.

- English → Output in clear English.
- Hinglish → Output in natural Hinglish (English letters only).
- Bengalish → Output in natural Bengalish (English letters only).

Fix grammar, spelling, punctuation, typos, sentence structure, chat abbreviations, phonetic spellings, and merged or broken words when the intended meaning is clear.

Make the message clear, polite, natural, and pleasant to read so the customer feels respected and comfortable, while keeping the original meaning.

Rearrange the words if required for better understanding but do not change the meaning.

Return only the rewritten message.`;

/**
 * Validate if message meets minimum requirements for AI improvement
 */
function validateMessageForImprovement(text) {
    if (!text || typeof text !== 'string') {
        return { valid: false, reason: 'Invalid input' };
    }

    const trimmedText = text.trim();
    const charCount = trimmedText.length;
    const wordCount = trimmedText.split(/\s+/).filter(Boolean).length;

    if (charCount < 15) {
        return { valid: false, reason: 'Message too short (< 15 characters)' };
    }

    if (wordCount < 4) {
        return { valid: false, reason: 'Message too short (< 4 words)' };
    }

    return { valid: true };
}

function extractResponseText(responseData) {
    if (typeof responseData.output_text === 'string' && responseData.output_text.trim()) {
        return responseData.output_text.trim();
    }

    const outputItems = Array.isArray(responseData.output) ? responseData.output : [];
    const textParts = [];

    for (const item of outputItems) {
        if (!Array.isArray(item.content)) {
            continue;
        }

        for (const contentPart of item.content) {
            if (contentPart.type === 'output_text' && typeof contentPart.text === 'string') {
                textParts.push(contentPart.text);
            }
        }
    }

    const combinedText = textParts.join('\n').trim();
    return combinedText || null;
}

function buildResponsesPayload(model, staffMessage) {
    return {
        model,
        instructions: SYSTEM_PROMPT,
        input: staffMessage,
        max_output_tokens: 500,
        text: {
            verbosity: 'low',
        },
    };
}

async function requestImprovementFromOpenAI(model, staffMessage) {
    const response = await axios.post(
        'https://api.openai.com/v1/responses',
        buildResponsesPayload(model, staffMessage),
        {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            timeout: 10000,
        }
    );

    return extractResponseText(response.data);
}

function shouldFallbackToLegacyModel(error) {
    const statusCode = error?.response?.status;
    const errorCode = error?.response?.data?.error?.code;
    const errorMessage = error?.response?.data?.error?.message || error?.message || '';

    if (statusCode !== 400 && statusCode !== 404) {
        return false;
    }

    return errorCode === 'model_not_found' || /model|unsupported|not found/i.test(errorMessage);
}

/**
 * Call OpenAI API to improve the message
 */
async function improveMessage(staffMessage) {
    try {
        // Validate message first
        const validation = validateMessageForImprovement(staffMessage);
        if (!validation.valid) {
            return {
                success: false,
                error: validation.reason,
                original: staffMessage,
            };
        }

        if (!OPENAI_API_KEY) {
            logger.error('Message Improvement: OPENAI_API_KEY not set');
            return {
                success: false,
                error: 'OpenAI API key not configured',
                original: staffMessage,
            };
        }

        let improvedMessage;
        let modelUsed = PRIMARY_OPENAI_MODEL;

        try {
            improvedMessage = await requestImprovementFromOpenAI(PRIMARY_OPENAI_MODEL, staffMessage);
        } catch (error) {
            if (PRIMARY_OPENAI_MODEL !== FALLBACK_OPENAI_MODEL && shouldFallbackToLegacyModel(error)) {
                logger.warn('Message Improvement primary model unavailable, falling back', {
                    primaryModel: PRIMARY_OPENAI_MODEL,
                    fallbackModel: FALLBACK_OPENAI_MODEL,
                    status: error?.response?.status,
                    error: error?.response?.data?.error?.message || error.message,
                });
                improvedMessage = await requestImprovementFromOpenAI(FALLBACK_OPENAI_MODEL, staffMessage);
                modelUsed = FALLBACK_OPENAI_MODEL;
            } else {
                throw error;
            }
        }

        if (!improvedMessage) {
            return {
                success: false,
                error: 'Empty response from AI',
                original: staffMessage,
            };
        }

        return {
            success: true,
            original: staffMessage,
            improved: improvedMessage,
            model: modelUsed,
        };
    } catch (error) {
        logger.error('Message Improvement Error:', {
            message: error.message,
            code: error.code,
            originalText: staffMessage.substring(0, 100),
        });

        return {
            success: false,
            error: error.message || 'Failed to improve message',
            original: staffMessage,
        };
    }
}

module.exports = {
    improveMessage,
    validateMessageForImprovement,
};
