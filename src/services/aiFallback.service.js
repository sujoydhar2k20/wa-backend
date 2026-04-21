const axios = require('axios');
const { AiSetting, AiCategory } = require('../models');
const { logger } = require('../utils/logger');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * Check if an incoming text message passes the allowlist/blocklist filters.
 * Returns true if the message should be sent to AI.
 */
function passesFilters(text, allowlist, blocklist) {
    const lowerText = text.toLowerCase();

    // Allowlist check: at least one keyword must match
    if (allowlist && allowlist.trim()) {
        const allowedKeywords = allowlist.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
        const hasAllowedKeyword = allowedKeywords.some(keyword => {
            // Word-boundary matching (case-insensitive)
            const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            return regex.test(lowerText);
        });
        if (!hasAllowedKeyword) {
            logger.info(`AI Fallback: Message blocked by allowlist (no keyword match)`);
            return false;
        }
    }

    // Blocklist check: if any blocked keyword matches, reject
    if (blocklist && blocklist.trim()) {
        const blockedKeywords = blocklist.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
        const hasBlockedKeyword = blockedKeywords.some(keyword => {
            const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            return regex.test(lowerText);
        });
        if (hasBlockedKeyword) {
            logger.info(`AI Fallback: Message blocked by blocklist`);
            return false;
        }
    }

    return true;
}

/**
 * Build the full system prompt by appending the category list to the user's custom prompt.
 */
function buildSystemPrompt(basePrompt, categories) {
    let categoryText = '\n\nAllowed Main Category and Sub Category:\n\n';
    categories.forEach((cat, idx) => {
        categoryText += `${idx + 1}. Main Category: ${cat.name}\n`;
        if (cat.subcategories && cat.subcategories.length > 0) {
            categoryText += `   Sub Category: ${cat.subcategories.map(s => s.name).join(', ')}\n`;
        }
        categoryText += '\n';
    });

    return basePrompt + categoryText;
}

/**
 * Call OpenAI to extract structured data from a customer message.
 * Returns parsed JSON or null on failure.
 */
async function callOpenAI(systemPrompt, userMessage) {
    if (!OPENAI_API_KEY) {
        logger.error('AI Fallback: OPENAI_API_KEY not set');
        return null;
    }

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage },
                ],
                max_completion_tokens: 500,
                temperature: 0.1,
            },
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                timeout: 15000,
            }
        );

        const text = response.data?.choices?.[0]?.message?.content?.trim();
        logger.info(`AI Fallback: OpenAI raw response: ${text}`);

        if (!text) return null;

        // Strip markdown code fence if present
        const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

        const parsed = JSON.parse(cleaned);
        return parsed;
    } catch (error) {
        logger.error(`AI Fallback: OpenAI call failed: ${error.response?.data?.error?.message || error.message}`);
        return null;
    }
}

/**
 * Match the AI response to category/subcategory links and build reply URLs.
 * Supports single or multiple category matches from the AI.
 */
function buildCategoryLinks(aiResponse, categories) {
    const results = [];

    // Normalize AI response: could be { results: [...] } or single object or array
    let items = [];
    if (Array.isArray(aiResponse)) {
        items = aiResponse;
    } else if (aiResponse.results && Array.isArray(aiResponse.results)) {
        items = aiResponse.results;
    } else {
        items = [aiResponse];
    }

    for (const item of items) {
        // Normalize keys: OpenAI may return "Main Category", "mainCategory", "main_category", etc.
        const normalized = {};
        for (const [key, value] of Object.entries(item)) {
            normalized[key.toLowerCase().replace(/[\s_-]+/g, '')] = value;
        }

        const mainCatName = normalized.maincategory || normalized.category || '';
        const subCatName = normalized.subcategory || '';
        const filters = {};

        // Extract filters (also from normalized keys)
        if (normalized.purity != null && normalized.purity !== '' && normalized.purity !== null) filters.purity = normalized.purity;
        if (normalized.size != null && normalized.size !== '' && normalized.size !== null) filters.size = normalized.size;
        if (normalized.pricemax != null && normalized.pricemax !== '' && normalized.pricemax !== null) filters.priceMax = normalized.pricemax;
        if (normalized.weightmax != null && normalized.weightmax !== '' && normalized.weightmax !== null) filters.weightMax = normalized.weightmax;

        // Find matching category
        const matchedCat = categories.find(c =>
            c.name.toLowerCase() === mainCatName.toLowerCase()
        );

        if (!matchedCat) continue;

        // If subcategory is specified, find it
        if (subCatName) {
            const matchedSub = matchedCat.subcategories.find(s =>
                s.name.toLowerCase() === subCatName.toLowerCase()
            );

            if (matchedSub) {
                const url = appendFilters(matchedSub.link, filters);
                results.push({ category: matchedCat.name, subcategory: matchedSub.name, url });
            } else {
                // Sub not found, use main category link
                const url = appendFilters(matchedCat.link, filters);
                results.push({ category: matchedCat.name, subcategory: subCatName, url });
            }
        } else {
            // No specific subcategory, use the main category link
            const url = appendFilters(matchedCat.link, filters);
            results.push({ category: matchedCat.name, subcategory: null, url });
        }
    }

    return results;
}

/**
 * Append filter params to a base URL.
 */
function appendFilters(baseUrl, filters) {
    if (!filters || Object.keys(filters).length === 0) return baseUrl;

    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(filters)) {
        if (value != null && value !== '' && value !== 'null') {
            url.searchParams.set(key, String(value));
        }
    }
    return url.toString();
}

/**
 * Build a language-appropriate reply message from the matched links.
 */
function buildReplyMessage(links, aiResponse, language) {
    // Detect language from AI response
    const lang = (language || aiResponse?.language || 'english').toLowerCase();

    const greetings = {
        english: '✨ Here are the results for your search:',
        hindi: '✨ यहाँ आपकी खोज के नतीजे हैं:',
        bengali: '✨ আপনার অনুসন্ধানের ফলাফল এখানে:',
    };

    const viewText = {
        english: '👉 View',
        hindi: '👉 देखें',
        bengali: '👉 দেখুন',
    };

    const greeting = greetings[lang] || greetings.english;
    const view = viewText[lang] || viewText.english;

    const lines = [greeting, ''];

    for (const link of links) {
        if (link.subcategory) {
            lines.push(`${view} ${link.subcategory}:`);
        } else {
            lines.push(`${view} ${link.category}:`);
        }
        lines.push(link.url);
        lines.push('');
    }

    return lines.join('\n').trim();
}

/**
 * Main AI Fallback handler.
 * Called from webhook.service.js when a text message doesn't match a product code.
 */
async function handleAiFallback(waba, phoneNumberId, chat, message, text, whatsappService) {
    try {
        // 1. Load AI Settings
        const settings = await AiSetting.findOne().lean();
        if (!settings || !settings.isAiFallbackEnabled) {
            logger.info('AI Fallback: Disabled, skipping.');
            return false;
        }

        // 2. Testing mode gate
        if (!settings.isTestingMode && settings.testPhoneNumber) {
            if (chat.waId !== settings.testPhoneNumber) {
                logger.info(`AI Fallback: Testing mode active, skipping for ${chat.waId}`);
                return false;
            }
        }

        // 3. Allowlist / Blocklist filter
        if (!passesFilters(text, settings.allowlist, settings.blocklist)) {
            return false;
        }

        // 4. Load categories
        const categories = await AiCategory.find().lean();
        if (!categories.length) {
            logger.warn('AI Fallback: No categories configured, skipping.');
            return false;
        }

        // 5. Build prompt and call OpenAI
        const systemPrompt = buildSystemPrompt(settings.systemPrompt, categories);
        const aiResponse = await callOpenAI(systemPrompt, text);

        if (!aiResponse) {
            logger.warn('AI Fallback: No valid response from OpenAI');
            return false;
        }

        // 6. Match to category links
        const links = buildCategoryLinks(aiResponse, categories);

        if (!links.length) {
            logger.info('AI Fallback: No category match found in AI response');
            return false;
        }

        // 7. Build and send reply
        const replyText = buildReplyMessage(links, aiResponse);
        
        logger.info(`AI Fallback: Sending reply with ${links.length} link(s) to ${chat.waId}`);

        const waResult = await whatsappService.sendTextMessage(
            waba._id,
            phoneNumberId,
            chat.waId,
            replyText,
            message.messageId // reply to the original message
        );

        // 8. Save outbound message to DB
        const { Message, Chat } = require('../models');
        const msgId = waResult?.messages?.[0]?.id;
        const outboundMsg = await Message.create({
            chatId: chat._id,
            wabaId: waba._id,
            phoneNumberId,
            messageId: msgId,
            waId: chat.waId,
            direction: 'outbound',
            type: 'text',
            text: replyText,
            status: 'sent',
            sentByBot: true,
            metadata: {
                autoReplyType: 'ai_fallback',
                aiResponse,
                matchedLinks: links,
                source: 'ai_fallback',
            },
            replyToMessageId: message._id,
        });

        // Update chat
        await Chat.findByIdAndUpdate(chat._id, { lastMessageAt: new Date(), lastStaffMessageAt: new Date() });

        // Emit socket
        try {
            const { getIO } = require('../websocket/socket.server');
            const io = getIO();
            io.emit('message:new', { chatId: chat._id, message: outboundMsg });
        } catch (e) {
            logger.warn('AI Fallback: Socket emit failed:', e.message);
        }

        logger.info(`AI Fallback: Successfully replied to ${chat.waId}`);
        return true;

    } catch (error) {
        logger.error(`AI Fallback error: ${error.message}`);
        return false;
    }
}

module.exports = {
    handleAiFallback,
    passesFilters,
    buildCategoryLinks,
    buildReplyMessage,
};
