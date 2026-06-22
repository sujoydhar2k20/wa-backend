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

    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const splitKeywords = (value) => String(value || '')
        .split(/[,;\n]+/)
        .map(k => k.trim().toLowerCase())
        .filter(Boolean);

    const hasKeywordMatch = (sourceText, keyword) => {
        const escaped = escapeRegExp(keyword);
        const isAsciiKeyword = /^[\x00-\x7F]+$/.test(keyword);

        // \b is ASCII-centric in JS regex; use Unicode-aware boundaries for non-ASCII scripts.
        const pattern = isAsciiKeyword
            ? `\\b${escaped}\\b`
            : `(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`;

        try {
            const regex = new RegExp(pattern, isAsciiKeyword ? 'i' : 'iu');
            return regex.test(sourceText);
        } catch (error) {
            // Fallback for environments without Unicode property escapes.
            return sourceText.includes(keyword);
        }
    };

    // Allowlist check: at least one keyword must match
    if (allowlist && allowlist.trim()) {
        const allowedKeywords = splitKeywords(allowlist);
        const hasAllowedKeyword = allowedKeywords.some(keyword => {
            return hasKeywordMatch(lowerText, keyword);
        });
        if (!hasAllowedKeyword) {
            logger.info(`AI Fallback: Message blocked by allowlist (no keyword match)`);
            return false;
        }
    }

    // Blocklist check: if any blocked keyword matches, reject
    if (blocklist && blocklist.trim()) {
        const blockedKeywords = splitKeywords(blocklist);
        const hasBlockedKeyword = blockedKeywords.some(keyword => {
            return hasKeywordMatch(lowerText, keyword);
        });
        if (hasBlockedKeyword) {
            logger.info(`AI Fallback: Message blocked by blocklist`);
            return false;
        }
    }

    return true;
}

/**
 * Build the system prompt from the user's saved custom prompt only.
 */
function buildSystemPrompt(basePrompt, categories, filterParameters = []) {
    void categories;
    void filterParameters;
    return String(basePrompt || '').trim();
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
        const usage = response.data?.usage;
        logger.info(`AI Fallback: OpenAI raw response: ${text}`);

        if (!text) return null;

        // Strip markdown code fence if present
        const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

        const parsed = JSON.parse(cleaned);
        return { parsed, usage };
    } catch (error) {
        logger.error(`AI Fallback: OpenAI call failed: ${error.response?.data?.error?.message || error.message}`);
        return null;
    }
}

/**
 * Match the AI response to category/subcategory links and build reply URLs.
 * Supports single or multiple category matches from the AI.
 */
function buildCategoryLinks(aiResponse, categories, settings) {
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

    const allowedFilterKeys = (settings?.filterParameters || ['&purity=', '&size=', '&priceMax=', '&weightMax=']).map(param => 
        param.replace(/^[&?]/, '').replace(/=$/, '')
    );

    for (const item of items) {
        // Normalize keys: OpenAI may return "Main Category", "mainCategory", "main_category", etc.
        const normalized = {};
        for (const [key, value] of Object.entries(item)) {
            normalized[key.toLowerCase().replace(/[\s_-]+/g, '')] = value;
        }

        const mainCatName = normalized.maincategory || normalized.category || '';
        const subCatName = normalized.subcategory || '';
        const filters = {};

        // Extract filters dynamically
        for (const key of Object.keys(normalized)) {
            const matchedKey = allowedFilterKeys.find(k => k.toLowerCase() === key.toLowerCase());
            if (matchedKey && normalized[key] != null && normalized[key] !== '' && normalized[key] !== 'null' && normalized[key] !== null) {
                filters[matchedKey] = normalized[key];
            }
        }

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

    try {
        const url = new URL(baseUrl);
        for (const [key, value] of Object.entries(filters)) {
            if (value != null && value !== '' && value !== 'null') {
                url.searchParams.set(key, String(value));
            }
        }
        return url.toString();
    } catch (e) {
        // Fallback for non-absolute URLs
        let urlStr = baseUrl;
        for (const [key, value] of Object.entries(filters)) {
            if (value != null && value !== '' && value !== 'null') {
                const separator = urlStr.includes('?') ? '&' : '?';
                urlStr += `${separator}${key}=${encodeURIComponent(String(value))}`;
            }
        }
        return urlStr;
    }
}

/**
 * Build a language-appropriate reply message from the matched links.
 */
function buildReplyMessage(links, aiResponse, settings) {
    // Detect language from AI response
    const lang = (aiResponse?.language || 'english').toLowerCase();

    const greetings = {
        english: settings?.englishGreeting || '✨ Here are the results for your search:',
        hindi: settings?.hindiGreeting || '✨ यहाँ आपकी खोज के नतीजे हैं:',
        bengali: settings?.bengaliGreeting || '✨ আপনার অনুসন্ধানের ফলাফল এখানে:',
    };

    const viewText = {
        english: settings?.englishViewText || '👉 View',
        hindi: settings?.hindiViewText || '👉 देखें',
        bengali: settings?.bengaliViewText || '👉 দেখুন',
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
    const { Message, Chat } = require('../models');
    try {
        // 1. Load AI Settings
        const settings = await AiSetting.findOne().lean();
        if (!settings) return false;
        if (!settings.systemPrompt || !settings.systemPrompt.trim()) {
            logger.warn('AI Fallback: No saved system prompt configured, skipping.');
            return false;
        }

        // Check if the current user is the test user.
        // Match tolerantly: waIds carry the country code (e.g. "917278665321") while the
        // admin often enters the number without it (e.g. "7278665321"). Compare digits-only
        // and allow a country-code-less suffix match so either form works.
        const normalizeNumber = (n) => String(n || '').replace(/\D/g, '');
        const waDigits = normalizeNumber(chat.waId);
        const testDigits = normalizeNumber(settings.testPhoneNumber);
        const minLen = Math.min(waDigits.length, testDigits.length);
        const numberMatches = testDigits.length > 0 && minLen >= 8 && (
            waDigits === testDigits ||
            waDigits.endsWith(testDigits) ||
            testDigits.endsWith(waDigits)
        );
        const isTestUser = !settings.isTestingMode && numberMatches;

        if (settings.isAiFallbackEnabled) {
            // Restrict to test number if isTestingMode is false (Specific Number)
            if (!settings.isTestingMode && !isTestUser) {
                logger.info(`AI Fallback: Testing mode active, skipping for non-test user ${chat.waId}`);
                return false;
            }
        } else {
            // Globally disabled. Only allow if testing mode is active (isTestingMode = false) AND this is the test user.
            if (!isTestUser) {
                logger.info(`AI Fallback: Disabled globally, skipping for ${chat.waId}`);
                return false;
            }
            logger.info(`AI Fallback: Disabled globally but allowing test user ${chat.waId}`);
        }


        // 3. Pre-filter (Length)
        if (text.length < 3) {
             logger.info(`AI Fallback: Message too short (${text.length} chars), skipping.`);
             await Message.create({
                 chatId: chat._id,
                 wabaId: waba._id,
                 direction: 'internal',
                 type: 'system',
                 text: `AI Skipped: Message too short`,
                 sentByBot: true,
                 metadata: {
                     aiSkipped: true,
                     aiSkipReason: 'Pre-filtered: Too short (1-2 characters)',
                     originalText: text
                 }
             });
             return false;
        }

        // 4. Allowlist / Blocklist filter
        if (!passesFilters(text, settings.allowlist, settings.blocklist)) {
            await Message.create({
                chatId: chat._id,
                wabaId: waba._id,
                direction: 'internal',
                type: 'system',
                text: `AI Skipped: Filtered by keywords`,
                sentByBot: true,
                metadata: {
                    aiSkipped: true,
                    aiSkipReason: 'Pre-filtered: Keyword restriction',
                    originalText: text
                }
            });
            return false;
        }

        // 5. Load categories
        const categories = await AiCategory.find().lean();
        if (!categories.length) {
            logger.warn('AI Fallback: No categories configured, skipping.');
            return false;
        }

        // 6. Build prompt and call OpenAI
        const filterParameters = settings.filterParameters || ['&purity=', '&size=', '&priceMax=', '&weightMax='];
        const systemPrompt = buildSystemPrompt(settings.systemPrompt, categories, filterParameters);
        const openaiResult = await callOpenAI(systemPrompt, text);

        if (!openaiResult || !openaiResult.parsed) {
            logger.warn('AI Fallback: No valid response from OpenAI');
            return false;
        }

        const { parsed: aiResponse, usage } = openaiResult;

        // 7. Match to category links
        const links = buildCategoryLinks(aiResponse, categories, settings);

        if (!links.length) {
            logger.info('AI Fallback: No category match found in AI response');
            // Log as success call but no match
            await Message.create({
                chatId: chat._id,
                wabaId: waba._id,
                direction: 'internal',
                type: 'system',
                text: `AI: No product category match`,
                sentByBot: true,
                metadata: {
                    aiSkipped: true,
                    aiSkipReason: 'No Product Match',
                    usage,
                    aiResponse
                }
            });
            return false;
        }

        // 8. Build and send reply
        const replyText = buildReplyMessage(links, aiResponse, settings);
        
        logger.info(`AI Fallback: Sending reply with ${links.length} link(s) to ${chat.waId}`);

        const waResult = await whatsappService.sendTextMessage(
            waba._id,
            phoneNumberId,
            chat.waId,
            replyText,
            message.messageId // reply to the original message
        );

        // 9. Save outbound message to DB
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
                usage,
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
