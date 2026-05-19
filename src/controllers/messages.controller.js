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
 * Detect the real MIME type of a document from its binary magic bytes.
 * Server Content-Type headers are often wrong (guessed from extension).
 * Meta rejects uploads whose declared MIME type doesn't match the content.
 *
 * Supported by Meta for documents:
 *   PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, TXT, CSV, RTF, ZIP, RAR
 */
function detectDocumentMimeType(buffer, fallback) {
    if (buffer.length < 8) return fallback;

    // PDF: %PDF
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
        return 'application/pdf';
    }
    // ZIP-based (DOCX, XLSX, PPTX — all use the Office Open XML / ZIP container)
    if (buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04) {
        // Distinguish by the declared fallback/extension since all share PK magic
        if (fallback.includes('word') || fallback.includes('docx') || fallback.includes('doc')) {
            return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        }
        if (fallback.includes('sheet') || fallback.includes('xlsx') || fallback.includes('xls')) {
            return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        }
        if (fallback.includes('presentation') || fallback.includes('pptx') || fallback.includes('ppt')) {
            return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        }
        return 'application/zip';
    }
    // OLE2 compound document (old DOC, XLS, PPT)
    if (buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0) {
        if (fallback.includes('xls')) return 'application/vnd.ms-excel';
        if (fallback.includes('ppt')) return 'application/vnd.ms-powerpoint';
        return 'application/msword';
    }
    // RAR: Rar!
    if (buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72 && buffer[3] === 0x21) {
        return 'application/vnd.rar';
    }

    return fallback;
}

/**
 * Re-encode a video to H.264/AAC MP4 using system ffmpeg.
 * Meta only accepts H.264 video + AAC audio in an MP4 container.
 * H.265/HEVC, VP9, AV1, and other codecs are rejected with error 131053.
 */
async function convertVideoToH264(buffer) {
    const tmpIn = path.join(os.tmpdir(), `wa_video_in_${Date.now()}_${process.pid}.mp4`);
    const tmpOut = path.join(os.tmpdir(), `wa_video_out_${Date.now()}_${process.pid}.mp4`);
    try {
        await fs.promises.writeFile(tmpIn, buffer);
        await new Promise((resolve, reject) => {
            execFile('ffmpeg', [
                '-y', '-i', tmpIn,
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '28',
                '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart',
                tmpOut
            ], { timeout: 120000 }, (err) => {
                if (err) reject(new Error(`ffmpeg video conversion failed: ${err.message}`));
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

            // Look up the template from DB to store its components for chat preview
            const Template = require('../models/Template');
            const templateDoc = await Template.findOne({ wabaId: chat.wabaId, name: templateName, language: language || 'en' });
            if (templateDoc) {
                // Build resolved components with variables injected for display
                const resolvedComponents = (templateDoc.components || []).map(comp => {
                    const c = comp.toObject ? comp.toObject() : { ...comp };
                    if (c.text && (c.type === 'BODY' || c.type === 'HEADER')) {
                        // Find matching component variables from the request
                        const compType = c.type.toLowerCase();
                        const vars = (components || []).find(v => v.type === compType);
                        if (vars && vars.parameters) {
                            let resolvedText = c.text;
                            vars.parameters.forEach((param, idx) => {
                                resolvedText = resolvedText.replace(`{{${idx + 1}}}`, param.text || `{{${idx + 1}}}`);
                            });
                            c.text = resolvedText;
                        }
                    }
                    return c;
                });
                // Store template data in a variable to be saved in metadata below
                req._templateData = {
                    templateName,
                    language: language || 'en',
                    components: resolvedComponents,
                };
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

                    // Always re-encode video to H.264/AAC MP4 — Meta rejects H.265/HEVC,
                    // VP9, AV1, and any other codec with error 131053.
                    if (type === 'video') {
                        buffer = await convertVideoToH264(buffer);
                        mimeType = 'video/mp4';
                        logger.info(`Video re-encoded to H.264/AAC MP4 (${buffer.length} bytes)`);
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

                    // Correct document MIME type from magic bytes — servers often serve
                    // wrong Content-Type for documents (e.g. application/octet-stream).
                    if (type === 'document') {
                        const corrected = detectDocumentMimeType(buffer, mimeType);
                        if (corrected !== mimeType) {
                            logger.info(`Document MIME corrected: ${mimeType} → ${corrected}`);
                            mimeType = corrected;
                        }
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

        // Build readable text for template messages from the resolved body component
        let messageText;
        if (type === 'text') {
            messageText = text;
        } else if (type === 'template') {
            const bodyComp = req._templateData?.components?.find(c => c.type === 'BODY');
            messageText = bodyComp?.text || `[template message] ${templateName}`;
        }

        const message = await Message.create({
            chatId,
            wabaId: chat.wabaId,
            phoneNumberId: chat.phoneNumberId,
            messageId: msgId,
            waId: chat.waId,
            direction: 'outbound',
            type,
            text: messageText,
            mediaUrl: mediaUrl || undefined,
            caption: caption || undefined,
            status: 'sent',
            sentBy: req.user._id,
            replyToMessageId: replyToMessageId || undefined,
            metadata: type === 'template' && req._templateData ? {
                templateName: req._templateData.templateName,
                templateLanguage: req._templateData.language,
                templateComponents: req._templateData.components,
            } : undefined,
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

                    if (type === 'video') {
                        buffer = await convertVideoToH264(buffer);
                        mimeType = 'video/mp4';
                    }

                    // Always convert images to JPEG for WhatsApp compatibility
                    if (type === 'image') {
                        const sharp = require('sharp');
                        buffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
                        mimeType = 'image/jpeg';
                    }

                    if (type === 'document') {
                        const corrected = detectDocumentMimeType(buffer, mimeType);
                        if (corrected !== mimeType) mimeType = corrected;
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
