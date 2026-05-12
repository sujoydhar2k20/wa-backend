const { Message, Chat } = require('../models');
const whatsappService = require('../services/whatsapp.service');
const { logger } = require('../utils/logger');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Convert a WebM/Opus audio buffer to OGG/Opus using system ffmpeg.
 * Required because browsers record in WebM but Meta only accepts
 * AAC, MP3, MP4-audio, AMR, or OGG/Opus for outbound audio messages.
 */
async function convertWebmToOgg(buffer) {
    const tmpIn = path.join(os.tmpdir(), `wa_audio_in_${Date.now()}_${process.pid}`);
    const tmpOut = path.join(os.tmpdir(), `wa_audio_out_${Date.now()}_${process.pid}.ogg`);
    try {
        await fs.promises.writeFile(tmpIn, buffer);
        await new Promise((resolve, reject) => {
            execFile('ffmpeg', ['-y', '-i', tmpIn, '-c:a', 'libopus', '-b:a', '64k', tmpOut], { timeout: 30000 }, (err) => {
                if (err) reject(new Error(`ffmpeg conversion failed: ${err.message}`));
                else resolve();
            });
        });
        return await fs.promises.readFile(tmpOut);
    } finally {
        fs.promises.unlink(tmpIn).catch(() => {});
        fs.promises.unlink(tmpOut).catch(() => {});
    }
}

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

                    // Detect actual format from binary magic bytes (browsers may mislabel blobs).
                    // WebM magic: 0x1A 0x45 0xDF 0xA3 (EBML header used by WebM/MKV).
                    // Meta does not accept audio/webm — convert to OGG/Opus via ffmpeg.
                    const isWebm = buffer.length >= 4 &&
                        buffer[0] === 0x1A && buffer[1] === 0x45 &&
                        buffer[2] === 0xDF && buffer[3] === 0xA3;

                    if (type === 'audio' && isWebm) {
                        buffer = await convertWebmToOgg(buffer);
                        mimeType = 'audio/ogg';
                        logger.info(`Audio converted from WebM to OGG/Opus (${buffer.length} bytes)`);
                    } else if (type === 'audio' && mimeType === 'video/mp4') {
                        mimeType = 'audio/mp4';
                    }

                    // Always convert ALL images to JPEG — CDN headers and file extensions
                    // are unreliable (e.g. WebP served as image/jpeg with .jpg extension).
                    // Running every image through sharp guarantees a valid JPEG for Meta.
                    if (type === 'image') {
                        const sharp = require('sharp');
                        buffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
                        mimeType = 'image/jpeg';
                        logger.info(`Image converted to JPEG (${buffer.length} bytes) from ${mediaUrl.substring(0, 80)}`);
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

/**
 * Retry a failed message: re-sends via WhatsApp and updates the EXISTING
 * message document instead of creating a new one. No duplicates.
 */
async function retry(req, res, next) {
    try {
        const message = await Message.findById(req.params.id).populate('chatId');
        if (!message) return res.status(404).json({ success: false, message: 'Message not found' });

        const chat = await Chat.findById(message.chatId).populate('contactId');
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        const type = message.type;
        const mediaUrl = message.mediaUrl;
        const text = message.text;
        const caption = message.caption;

        let waResult;
        if (type === 'text') {
            waResult = await whatsappService.sendTextMessage(chat.wabaId, chat.phoneNumberId, chat.waId, text);
        } else if (['image', 'video', 'audio', 'document'].includes(type)) {
            let mediaIdToSend = mediaUrl;

            if (mediaUrl && mediaUrl.startsWith('http')) {
                try {
                    const axios = require('axios');
                    const response = await axios.get(mediaUrl, {
                        responseType: 'arraybuffer',
                        timeout: 30000,
                        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WhatsApp-Bot/1.0)' }
                    });
                    let buffer = Buffer.from(response.data, 'binary');
                    let mimeType = response.headers['content-type'] || 'image/jpeg';
                    mimeType = mimeType.split(';')[0].trim();

                    const isWebm = buffer.length >= 4 &&
                        buffer[0] === 0x1A && buffer[1] === 0x45 &&
                        buffer[2] === 0xDF && buffer[3] === 0xA3;

                    if (type === 'audio' && isWebm) {
                        buffer = await convertWebmToOgg(buffer);
                        mimeType = 'audio/ogg';
                    } else if (type === 'audio' && mimeType === 'video/mp4') {
                        mimeType = 'audio/mp4';
                    }

                    // Always convert images to JPEG for WhatsApp compatibility
                    if (type === 'image') {
                        const sharp = require('sharp');
                        buffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
                        mimeType = 'image/jpeg';
                    }

                    mediaIdToSend = await retryWithBackoff(
                        () => whatsappService.uploadMedia(chat.wabaId, chat.phoneNumberId, buffer, mimeType)
                    );
                } catch (err) {
                    logger.error(`Retry: Error processing/uploading media: ${err.message}`);
                    return res.status(500).json({ success: false, message: `Failed to upload media: ${err.message}` });
                }
            }

            waResult = await retryWithBackoff(
                () => whatsappService.sendMediaMessage(chat.wabaId, chat.phoneNumberId, chat.waId, type, mediaIdToSend, caption || '')
            );
        } else {
            return res.status(400).json({ success: false, message: `Cannot retry message type: ${type}` });
        }

        // Update the EXISTING message (no duplicate created)
        const newMsgId = waResult?.messages?.[0]?.id;
        message.messageId = newMsgId;
        message.status = 'sent';
        message.errorCode = undefined;
        message.errorMessage = undefined;
        await message.save();

        await message.populate('sentBy', 'name phone');

        // Emit status update (NOT message:new) so frontend updates in-place
        const { getIO } = require('../websocket/socket.server');
        getIO().emit('message:status', {
            chatId: chat._id.toString(),
            messageId: message._id.toString(),
            waMessageId: newMsgId,
            status: 'sent'
        });

        res.json(message);
    } catch (e) {
        logger.error(`Retry failed: ${e.message}`);
        next(e);
    }
}

/**
 * Bulk-send multiple media messages (primarily product images).
 * Creates all Message documents instantly and returns them to the frontend,
 * then schedules a background job to process the actual WhatsApp API sends
 * sequentially with rate-limit-safe delays.
 */
async function sendBulk(req, res, next) {
    try {
        const { chatId, items } = req.body;
        // items: Array of { type, mediaUrl, caption }
        if (!chatId) return res.status(400).json({ success: false, message: 'chatId is required' });
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: 'items array is required and must not be empty' });
        }
        if (items.length > 30) {
            return res.status(400).json({ success: false, message: 'Maximum 30 items per bulk send' });
        }

        const chat = await Chat.findById(chatId).populate('contactId');
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        // Enforce 24-hour session window
        const now = new Date();
        if (chat.sessionExpiresAt && chat.sessionExpiresAt < now) {
            return res.status(403).json({
                success: false,
                message: 'WhatsApp 24-hour session window has expired. You must use a Template Message.',
            });
        }

        // Create all message documents instantly with status 'queued'
        const messages = [];
        for (const item of items) {
            const msg = await Message.create({
                chatId,
                wabaId: chat.wabaId,
                phoneNumberId: chat.phoneNumberId,
                waId: chat.waId,
                direction: 'outbound',
                type: item.type || 'image',
                mediaUrl: item.mediaUrl,
                caption: item.caption || undefined,
                status: 'queued',
                sentBy: req.user._id,
            });
            await msg.populate('sentBy', 'name phone');
            messages.push(msg);
        }

        // Update chat last message timestamp
        await Chat.findByIdAndUpdate(chatId, { lastMessageAt: new Date(), lastStaffMessageAt: new Date() });

        // Emit all messages via socket so ALL connected clients see them instantly
        const { getIO } = require('../websocket/socket.server');
        for (const msg of messages) {
            getIO().emit('message:new', { chatId: chat._id, message: msg });
        }

        // Schedule background job to process the actual WhatsApp sends
        const { getAgenda } = require('../jobs/agenda');
        const agenda = getAgenda();
        await agenda.now('send-bulk-messages', {
            chatId: chatId.toString(),
            messageIds: messages.map(m => m._id.toString()),
        });

        // Return all messages immediately — frontend shows them as "queued/sending"
        res.status(201).json({ success: true, messages });
    } catch (e) {
        next(e);
    }
}

module.exports = { send, sendBulk, search, react, markRead, addNote, deleteMsg, retry };
