const { Message, Chat } = require('../models');
const whatsappService = require('../services/whatsapp.service');
const { logger } = require('../utils/logger');

/**
 * Retry a function with exponential backoff.
 * Handles transient Meta API errors (429 rate limits, 500 server errors, network timeouts).
 * @param {Function} fn - async function to retry
 * @param {number} maxRetries - maximum number of retry attempts (default 3)
 * @param {number} baseDelayMs - base delay in ms (default 1500, doubles each retry)
 * @returns {Promise<any>} - result of the function
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 1500) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const status = err.response?.status;
            // Only retry on rate limits (429), server errors (5xx), or network/timeout errors
            const isRetryable = status === 429 || (status >= 500 && status < 600) || !status;
            if (!isRetryable || attempt === maxRetries) {
                throw err;
            }
            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            logger.warn(`Meta API call failed (attempt ${attempt}/${maxRetries}, status: ${status || 'network error'}), retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

async function send(req, res, next) {
    try {
        const { chatId, type = 'text', text, mediaUrl, caption, templateName, language, components, replyToMessageId } = req.body;
        if (!chatId) return res.status(400).json({ success: false, message: 'chatId is required' });

        const chat = await Chat.findById(chatId).populate('contactId');
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        // Enforce 24-hour customer service window rule for non-template messages
        if (type !== 'template') {
            const now = new Date();
            // If sessionExpiresAt exists and we are past it, block the message
            if (chat.sessionExpiresAt && chat.sessionExpiresAt < now) {
                return res.status(403).json({
                    success: false,
                    message: 'WhatsApp 24-hour session window has expired. You must use a Template Message.',
                });
            }
        }

        let metaMessageIdToReply = null;
        if (replyToMessageId) {
            const parentMsg = await Message.findById(replyToMessageId);
            if (parentMsg && parentMsg.messageId) {
                metaMessageIdToReply = parentMsg.messageId;
            }
        }

        let waResult;
        if (type === 'text') {
            if (!text) return res.status(400).json({ success: false, message: 'text is required for text messages' });
            waResult = await whatsappService.sendTextMessage(chat.wabaId, chat.phoneNumberId, chat.waId, text, metaMessageIdToReply);
        } else if (type === 'template') {
            if (!templateName) return res.status(400).json({ success: false, message: 'templateName is required for template messages' });
            
            if (chat.contactId && (chat.contactId.isBlocked || chat.contactId.isOptedOut)) {
                return res.status(403).json({
                    success: false,
                    message: 'Cannot send template messages to blocked or opted-out contacts.',
                });
            }

            waResult = await whatsappService.sendTemplateMessage(chat.wabaId, chat.phoneNumberId, chat.waId, templateName, language || 'en', components || []);
        } else if (['image', 'video', 'audio', 'document'].includes(type)) {
            if (!mediaUrl) return res.status(400).json({ success: false, message: 'mediaUrl is required for media messages' });

            let mediaIdToSend = mediaUrl;

            // WhatsApp only supports JPEG/PNG as image type messages.
            // WebP and other formats MUST be converted to JPEG before uploading to Meta.
            // So we download the file, convert if needed, then re-upload to get a Meta media ID.
            if (mediaUrl.startsWith('http')) {
                try {
                    const axios = require('axios');
                    const response = await axios.get(mediaUrl, {
                        responseType: 'arraybuffer',
                        timeout: 30000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (compatible; WhatsApp-Bot/1.0)',
                        }
                    });
                    let buffer = Buffer.from(response.data, 'binary');
                    let mimeType = response.headers['content-type'] || 'image/jpeg';
                    mimeType = mimeType.split(';')[0].trim();

                    // Detect ACTUAL format from file magic bytes — CDN content-type headers
                    // are often wrong (e.g. WebP served as image/jpeg with .jpg extension).
                    if (type === 'image') {
                        const isWebP = buffer.length > 12
                            && buffer.slice(0, 4).toString('ascii') === 'RIFF'
                            && buffer.slice(8, 12).toString('ascii') === 'WEBP';
                        const isJpeg = buffer.length > 2 && buffer[0] === 0xFF && buffer[1] === 0xD8;
                        const isPng = buffer.length > 4 && buffer[0] === 0x89
                            && buffer.slice(1, 4).toString('ascii') === 'PNG';

                        if (isWebP) mimeType = 'image/webp';
                        else if (isJpeg) mimeType = 'image/jpeg';
                        else if (isPng) mimeType = 'image/png';

                        logger.info(`Image format detection: header=${response.headers['content-type']}, actual=${mimeType}, url=${mediaUrl.substring(0, 80)}`);
                    }

                    // WhatsApp explicitly requires 'audio/mp4' for voice notes
                    if (type === 'audio' && mimeType === 'video/mp4') {
                        mimeType = 'audio/mp4';
                    }

                    // Convert WebP (and other unsupported image formats) to JPEG
                    // WhatsApp only accepts image/jpeg and image/png for image messages
                    if (type === 'image' && !['image/jpeg', 'image/png'].includes(mimeType)) {
                        const sharp = require('sharp');
                        buffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
                        mimeType = 'image/jpeg';
                        logger.info(`Converted image to JPEG (${buffer.length} bytes)`);
                    }

                    // Retry upload to Meta with exponential backoff (handles 429 rate limits)
                    mediaIdToSend = await retryWithBackoff(
                        () => whatsappService.uploadMedia(chat.wabaId, chat.phoneNumberId, buffer, mimeType)
                    );
                } catch (err) {
                    logger.error(`Error processing/uploading media to Meta: ${err.message}`);
                    return res.status(500).json({
                        success: false,
                        message: `Failed to upload media to WhatsApp: ${err.message}`
                    });
                }
            }

            // Retry send with exponential backoff (handles 429 rate limits when sending multiple images)
            waResult = await retryWithBackoff(
                () => whatsappService.sendMediaMessage(chat.wabaId, chat.phoneNumberId, chat.waId, type, mediaIdToSend, caption || '', metaMessageIdToReply)
            );
        } else {
            return res.status(400).json({ success: false, message: `Unsupported message type: ${type}` });
        }

        const msgId = waResult?.messages?.[0]?.id;
        const message = await Message.create({
            chatId,
            wabaId: chat.wabaId,
            phoneNumberId: chat.phoneNumberId,
            messageId: msgId,
            waId: chat.waId,
            direction: 'outbound',
            type,
            text: type === 'text' ? text : type === 'template' ? `[template message] ${templateName}` : undefined,
            mediaUrl: mediaUrl || undefined,
            caption: caption || undefined,
            status: 'sent',
            sentBy: req.user._id,
            replyToMessageId: replyToMessageId || undefined,
        });

        // Update chat last message timestamp
        await Chat.findByIdAndUpdate(chatId, { lastMessageAt: new Date(), lastStaffMessageAt: new Date() });

        // Populate sentBy so the response includes sender name for the chat UI
        await message.populate('sentBy', 'name phone');

        // Emit socket event globally so frontend updates instantly for other clients
        const { getIO } = require('../websocket/socket.server');
        getIO().emit('message:new', {
            chatId: chat._id,
            message: message
        });

        res.status(201).json(message);
    } catch (e) {
        next(e);
    }
}

async function search(req, res, next) {
    try {
        const { q, chatId, page = 1, limit = 20 } = req.query;
        if (!q) return res.status(400).json({ success: false, message: 'Query param q is required' });
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = { text: { $regex: q, $options: 'i' } };
        if (chatId) filter.chatId = chatId;

        const [messages, total] = await Promise.all([
            Message.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('sentBy', 'name phone'),
            Message.countDocuments(filter),
        ]);
        res.json({ data: messages, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

async function react(req, res, next) {
    try {
        const { emoji } = req.body;
        if (emoji === undefined) return res.status(400).json({ success: false, message: 'emoji is required' });

        const message = await Message.findById(req.params.id);
        if (!message) return res.status(404).json({ success: false, message: 'Message not found' });

        const chat = await Chat.findById(message.chatId);
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        await whatsappService.reactToMessage(chat.wabaId, chat.phoneNumberId, chat.waId, message.messageId, emoji);

        // Update database: remove existing reaction by this user, then add new one if not unreacting
        const userId = req.user._id.toString();
        message.reactions = message.reactions.filter(r => r.by !== userId);
        if (emoji) {
            message.reactions.push({ emoji, by: userId });
        }
        await message.save();

        // Emit socket event globally so frontend updates instantly
        const { getIO } = require('../websocket/socket.server');
        getIO().emit('message:reaction', {
            chatId: chat._id,
            messageId: message._id,
            reactions: message.reactions
        });

        res.json({ success: true, reactions: message.reactions });
    } catch (e) {
        next(e);
    }
}

async function markRead(req, res, next) {
    try {
        const message = await Message.findById(req.params.id);
        if (!message) return res.status(404).json({ success: false, message: 'Message not found' });

        const chat = await Chat.findById(message.chatId);
        if (chat && message.messageId) {
            await whatsappService.markMessageAsRead(chat.wabaId, message.messageId).catch(() => { });
        }
        await Message.findByIdAndUpdate(message._id, { status: 'read', statusTimestamp: new Date() });
        res.json({ success: true });
    } catch (e) {
        next(e);
    }
}

async function addNote(req, res, next) {
    try {
        const { chatId } = req.params;
        const { text } = req.body;
        if (!text) return res.status(400).json({ success: false, message: 'text is required' });

        const chat = await Chat.findById(chatId);
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        const message = await Message.create({
            chatId,
            wabaId: chat.wabaId,
            phoneNumberId: chat.phoneNumberId,
            waId: chat.waId,
            direction: 'internal',
            type: 'note',
            text,
            status: 'sent',
            sentBy: req.user._id,
        });

        const { getIO } = require('../websocket/socket.server');
        getIO().emit('message:new', {
            chatId: chat._id,
            message: await message.populate('sentBy', 'name phone')
        });

        res.status(201).json(message);
    } catch (e) {
        next(e);
    }
}

async function deleteMsg(req, res, next) {
    try {
        const message = await Message.findById(req.params.id);
        if (!message) return res.status(404).json({ success: false, message: 'Message not found' });

        const chatId = message.chatId;
        await Message.findByIdAndDelete(req.params.id);

        const { getIO } = require('../websocket/socket.server');
        getIO().emit('message:delete', {
            chatId,
            messageId: req.params.id
        });

        res.json({ success: true });
    } catch (e) {
        next(e);
    }
}

module.exports = { send, search, react, markRead, addNote, deleteMsg };
