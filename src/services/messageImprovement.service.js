const axios = require('axios');
const { logger } = require('../utils/logger');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * System prompt for improving staff messages
 */
const SYSTEM_PROMPT = `You are a Jewellery Store Message Assistant.

Rewrite the staff's message into clear, natural, customer-friendly language without changing the meaning.

Rules:

- Fix grammar, spelling, typos, and sentence structure.
- Rewrite for clarity, not just grammar. Fix obvious spelling mistakes, broken words, merged words, and informal chat typing when the intended meaning is clear.
- Keep all details exactly the same.
- Do not add greetings, apologies, marketing text, extra information, or answers.
- Do not translate, invent information, or change the meaning.
- Return only the rewritten message.

Language:

- English → Simple English.
- Hinglish → Natural Hinglish (English letters only).
- Bengalish → Natural Bengalish (English letters only).
- Mixed language → Keep the same style.

Language Detection:

- If words like apni, apnar, tumi, tomar, ache, nei, hobe, hoyeche, korte, korben, janaben, dekhben, lagbe, amake appear, treat as Bengalish.
- If words like aap, aapka, karna, karenge, hai, hain, hoga, nahi appear, treat as Hinglish.
- If both appear, use the language with more meaningful words.
- Words like accha, acha, ji, haan, okay alone must not determine the language.

Example:
Input: Accha tik ache apni amake janaben
Output: Accha, thik ache. Apni amake janaben.`;

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
                model: 'gpt-4o-mini', // Using gpt-4o-mini instead of gpt-5-nano as it's the recommended model
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
                temperature: 0.3, // Lower temperature for more consistent rewrites
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
