const axios = require('axios');
const { logger } = require('../utils/logger');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

Do not translate, add information, remove information, create promises, or answer customer questions.

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

    if (wordCount < 3) {
        return { valid: false, reason: 'Message too short (< 3 words)' };
    }

    return { valid: true };
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

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: SYSTEM_PROMPT,
                    },
                    {
                        role: 'user',
                        content: staffMessage,
                    },
                ],
                max_completion_tokens: 500,
                temperature: 0.3,
            },
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                timeout: 10000, // 10 second timeout
            }
        );

        const improvedMessage = response.data.choices[0]?.message?.content?.trim();

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
