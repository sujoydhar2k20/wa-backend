const { Message, Chat, Contact } = require('../models');
const whatsappService = require('../services/whatsapp.service');
const { logger } = require('../utils/logger');
const { addressOf } = require('../utils/waIdentity');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { escapeRegex, phoneSearchTerm } = require('../utils/regex');
/**
 * Convert any browser-recorded audio to AAC/M4A for Meta.
 * Uses ffmpeg's built-in AAC encoder — no libopus or libmp3lame required.
 * Meta supports audio/mp4 (AAC) natively for outbound audio messages.
 */
async function convertAudioForMeta(buffer) {
    const id = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2)}`;
    const tmpIn = path.join(os.tmpdir(), `wa_audio_in_${id}`);
    const tmpOut = path.join(os.tmpdir(), `wa_audio_out_${id}.m4a`);
    try {
        await fs.promises.writeFile(tmpIn, buffer);
        await new Promise((resolve, reject) => {
            execFile('ffmpeg', [
                '-y', '-i', tmpIn,
                '-vn',                  // strip any video stream
                '-c:a', 'aac',          // built-in AAC encoder, no extra library needed
                '-b:a', '128k',
                '-movflags', '+faststart',
                tmpOut
            ], { timeout: 60000 }, (err, _stdout, stderr) => {
                if (err) {
                    logger.error(`ffmpeg audio conversion failed: ${err.message}\nstderr: ${stderr}`);
                    reject(new Error(`ffmpeg audio conversion failed: ${err.message}`));
                } else {
                    if (stderr) logger.info(`ffmpeg audio stderr: ${stderr.slice(-300)}`);
                    resolve();
                }
            });
        });
        const result = await fs.promises.readFile(tmpOut);
        if (result.length === 0) throw new Error('ffmpeg produced an empty audio output file');
        logger.info(`Audio converted to AAC/M4A: ${buffer.length} → ${result.length} bytes`);
        return result;
    } finally {
        fs.promises.unlink(tmpIn).catch(() => {});
        fs.promises.unlink(tmpOut).catch(() => {});
    }
}

// WhatsApp shows the voice-message play icon only for OGG/OPUS files up to 512 KB.
const VOICE_PLAY_ICON_MAX_BYTES = 512 * 1024;

function runFfmpeg(args, timeout = 60000) {
    return new Promise((resolve, reject) => {
        execFile('ffmpeg', args, { timeout }, (err, _stdout, stderr) => {
            if (err) reject(new Error(`ffmpeg failed: ${err.message} ${String(stderr || '').slice(-300)}`));
            else resolve();
        });
    });
}

/**
 * Convert a staff-recorded voice note to OGG/OPUS mono for a WhatsApp voice message.
 * Tries libopus first, then ffmpeg's built-in (experimental) opus encoder for servers built without
 * libopus. Re-encodes at a lower bitrate if the file is over 512 KB (the play-icon limit).
 * Returns { buffer, oversize } or throws when no OPUS encoder works (the caller then falls back to an
 * ordinary audio attachment and says so).
 */
async function convertVoiceNoteForMeta(buffer) {
    const id = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2)}`;
    const tmpIn = path.join(os.tmpdir(), `wa_voice_in_${id}`);
    const tmpOut = path.join(os.tmpdir(), `wa_voice_out_${id}.ogg`);
    const encoders = [
        ['-c:a', 'libopus', '-application', 'voip'],
        ['-c:a', 'opus', '-strict', '-2', '-ar', '48000'],
    ];
    try {
        await fs.promises.writeFile(tmpIn, buffer);
        let lastErr;
        for (const enc of encoders) {
            for (const bitrate of ['32k', '16k', '12k']) {
                try {
                    await runFfmpeg(['-y', '-i', tmpIn, '-vn', '-ac', '1', ...enc, '-b:a', bitrate, '-f', 'ogg', tmpOut]);
                    const out = await fs.promises.readFile(tmpOut);
                    if (!out.length) throw new Error('ffmpeg produced an empty voice file');
                    if (out.length <= VOICE_PLAY_ICON_MAX_BYTES || bitrate === '12k') {
                        logger.info(`Voice note converted to OGG/OPUS (${enc[1]}, ${bitrate}): ${buffer.length} -> ${out.length} bytes`);
                        return { buffer: out, oversize: out.length > VOICE_PLAY_ICON_MAX_BYTES };
                    }
                } catch (e) {
                    lastErr = e;
                    break; // this encoder is unavailable/broken: try the next one
                }
            }
        }
        throw lastErr || new Error('No OPUS encoder available');
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

/**
 * POST /messages/send with optional idempotency.
 * When the app sends clientMessageId (one id per logical message, reused on every retry), a repeated
 * request returns the message created by the first one instead of sending to WhatsApp again.
 */
async function send(req, res, next) {
    const sendGuard = require('../services/sendGuard.service');
    const clientMessageId = sendGuard.normalizeClientId(req.body?.clientMessageId);
    const chatId = req.body?.chatId;
    if (!clientMessageId || !chatId || !/^[0-9a-fA-F]{24}$/.test(String(chatId))) return sendInner(req, res, next);

    let claim;
    try {
        claim = await sendGuard.claim({ chatId, clientMessageId, userId: req.user._id });
    } catch (e) {
        return next(e);
    }
    if (claim.existing) {
        try {
            const existing = await Message.findById(claim.existing)
                .populate('sentBy', 'name phone')
                .populate({ path: 'replyToMessageId', select: '_id text type mediaUrl caption waId sentBy', populate: { path: 'sentBy', select: 'name' } });
            if (existing) return res.status(200).json(existing);
        } catch (e) {
            return next(e);
        }
        await sendGuard.release(claim.key).catch(() => {});
        return res.status(409).json({ success: false, code: 'SEND_IN_PROGRESS', message: 'This message is still being sent. Please wait.' });
    }
    if (claim.inProgress) {
        return res.status(409).json({ success: false, code: 'SEND_IN_PROGRESS', message: 'This message is still being sent. Please wait.' });
    }

    req._clientMessageId = clientMessageId;
    let settled = false;
    const settle = (ok, body) => {
        if (settled) return;
        settled = true;
        const id = ok && body && (body._id || body.id);
        (id ? sendGuard.complete(claim.key, id) : sendGuard.release(claim.key)).catch(() => {});
    };
    const originalJson = res.json.bind(res);
    res.json = (body) => {
        settle(res.statusCode < 400, body);
        return originalJson(body);
    };
    return sendInner(req, res, (err) => {
        settle(false);
        next(err);
    });
}

async function sendInner(req, res, next) {
    try {
        const { chatId, type = 'text', text, mediaUrl, caption, templateName, language, components, replyToMessageId } = req.body;
        // Voice note recorded in the app/panel (not a picked audio file): sent as a WhatsApp voice message.
        const wantsVoice = type === 'audio' && (req.body.voice === true || req.body.voice === 'true');
        let sentAsVoice = false;
        let voiceNotice;
        if (!chatId) return res.status(400).json({ success: false, message: 'chatId is required' });

        const chat = await Chat.findById(chatId).populate('contactId');
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        // Block sending to blocked or opted-out contacts
        if (chat.contactId && (chat.contactId.isBlocked || chat.contactId.isOptedOut)) {
            return res.status(403).json({
                success: false,
                message: 'Cannot send messages to blocked or opted-out contacts.',
            });
        }

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
            waResult = await whatsappService.sendTextMessage(chat.wabaId, chat.phoneNumberId, addressOf(chat), text, metaMessageIdToReply);
        } else if (type === 'template') {
            if (!templateName) return res.status(400).json({ success: false, message: 'templateName is required for template messages' });

            console.log(`[DEBUG] Template message received - template: ${templateName}, language: ${language}, components from mobile:`, JSON.stringify(components || [], null, 2));

            // Look up the template from DB to store its components for chat preview
            const Template = require('../models/Template');
            const templateDoc = await Template.findOne({ wabaId: chat.wabaId, name: templateName, language: language || 'en' });
            if (templateDoc) {
                console.log(`[DEBUG] Template found in DB with ${templateDoc.components?.length || 0} components:`, JSON.stringify(templateDoc.components || [], null, 2));
                
                // Build resolved components with variables injected for display
                const resolvedComponents = (templateDoc.components || []).map(comp => {
                    const c = comp.toObject ? comp.toObject() : { ...comp };
                    // Only replace variables in TEXT format components (not IMAGE, VIDEO, DOCUMENT)
                    const format = c.format || 'TEXT';
                    if (c.text && format === 'TEXT' && (c.type === 'BODY' || c.type === 'HEADER')) {
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
                    // Resolve dynamic URL placeholders in BUTTONS components
                    if (c.type === 'BUTTONS' && Array.isArray(c.buttons)) {
                        c.buttons = c.buttons.map((btn, btnIndex) => {
                            const b = { ...btn };
                            if (b.type === 'URL' && typeof b.url === 'string' && b.url.includes('{{')) {
                                const btnVars = (components || []).find(
                                    v => v.type === 'button' && String(v.index) === String(btnIndex)
                                );
                                if (btnVars && Array.isArray(btnVars.parameters)) {
                                    let resolvedUrl = b.url;
                                    btnVars.parameters.forEach((param, idx) => {
                                        resolvedUrl = resolvedUrl.replace(`{{${idx + 1}}}`, param.text || `{{${idx + 1}}}`);
                                    });
                                    b.url = resolvedUrl;
                                }
                            }
                            return b;
                        });
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

            waResult = await whatsappService.sendTemplateMessage(chat.wabaId, chat.phoneNumberId, addressOf(chat), templateName, language || 'en', components || []);

            // For IMAGE headers, store our hosted copy (created/refreshed during send) in the message so
            // web and the Android app can render it. Meta's example CDN URLs are signed and expire.
            if (req._templateData) {
                const imageUrl = await whatsappService.getTemplateHeaderImageUrl(chat.wabaId, templateName, language || 'en');
                if (imageUrl) {
                    req._templateData.components = whatsappService.withHostedHeaderImage(req._templateData.components, imageUrl);
                    req._templateData.templateImageUrl = imageUrl;
                }
            }
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

                    // Always re-encode audio to OGG/Opus via ffmpeg.
                    // Browsers record in WebM, MP4, or other formats depending on platform.
                    // Magic-byte detection is unreliable when the VPS serves wrong Content-Type.
                    // ffmpeg accepts any valid input and always produces clean OGG/Opus for Meta.
                    if (type === 'audio' && wantsVoice) {
                        try {
                            const voice = await convertVoiceNoteForMeta(buffer);
                            buffer = voice.buffer;
                            mimeType = 'audio/ogg';
                            sentAsVoice = true;
                            if (voice.oversize) voiceNotice = 'oversize';
                        } catch (err) {
                            // Never pretend: send it as an ordinary audio file and record why.
                            logger.warn(`Voice note could not be converted to OGG/OPUS, sending as audio file: ${err.message}`);
                            voiceNotice = 'opus_unavailable';
                            buffer = await convertAudioForMeta(buffer);
                            mimeType = 'audio/mp4';
                        }
                    } else if (type === 'audio') {
                        buffer = await convertAudioForMeta(buffer);
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
                () => whatsappService.sendMediaMessage(chat.wabaId, chat.phoneNumberId, addressOf(chat), type, mediaIdToSend, caption || '', metaMessageIdToReply, { voice: sentAsVoice })
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

        // Build quotedMessage for outbound replies - same as webhook does for inbound
        let quotedMessage = null;
        if (replyToMessageId) {
            const parentMsg = await Message.findById(replyToMessageId).populate('sentBy', 'name');
            if (parentMsg) {
                let displayText = '';
                switch (parentMsg.type) {
                    case 'text':
                        displayText = parentMsg.text || '';
                        break;
                    case 'image':
                        displayText = '📷 Photo';
                        break;
                    case 'video':
                        displayText = '🎥 Video';
                        break;
                    case 'audio':
                        displayText = '🎙️ Voice Message';
                        break;
                    case 'document':
                        displayText = `📄 ${parentMsg.fileName || 'Document'}`;
                        break;
                    case 'location':
                        displayText = '📍 Location';
                        break;
                    case 'sticker':
                        displayText = '🖼️ Sticker';
                        break;
                    default:
                        displayText = parentMsg.text || `${parentMsg.type} message`;
                }

                // Determine sender name for quoted message
                let senderName = '';
                if (parentMsg.sentBy) {
                    senderName = typeof parentMsg.sentBy === 'object' ? parentMsg.sentBy.name : 'Staff';
                } else {
                    // Customer-sent message - use their profile name or number
                    const contact = await Contact.findOne({ waId: parentMsg.waId }).select('name nameOnWhatsApp').lean();
                    senderName = contact?.name || contact?.nameOnWhatsApp || parentMsg.waId;
                }

                quotedMessage = {
                    messageId: parentMsg.messageId,
                    text: parentMsg.text || '',
                    type: parentMsg.type,
                    waId: parentMsg.waId,
                    senderName: senderName,
                    caption: parentMsg.caption || null,
                    mediaUrl: parentMsg.mediaUrl || null,
                };
            }
        }

        const message = await Message.create({
            chatId,
            wabaId: chat.wabaId,
            phoneNumberId: chat.phoneNumberId,
            messageId: msgId,
            waId: chat.waId, bsuid: chat.bsuid,
            direction: 'outbound',
            type,
            text: messageText,
            mediaUrl: mediaUrl || undefined,
            caption: caption || undefined,
            status: 'sent',
            sentBy: req.user._id,
            clientMessageId: req._clientMessageId || undefined,
            replyToMessageId: replyToMessageId || undefined,
            quotedMessage: quotedMessage || undefined,
            metadata: type === 'template' && req._templateData ? {
                templateName: req._templateData.templateName,
                templateLanguage: req._templateData.language,
                templateComponents: req._templateData.components,
                templateImageUrl: req._templateData.templateImageUrl || undefined,
            } : type === 'audio' ? {
                voice: sentAsVoice,
                ...(voiceNotice ? { voiceNotice } : {}),
            } : undefined,
        });

        // Update chat last message timestamp
        await Chat.findByIdAndUpdate(chatId, { lastMessageAt: new Date(), lastStaffMessageAt: new Date() });

        // Populate sentBy and replyToMessageId so the response includes sender name and reply details for the chat UI
        await message.populate('sentBy', 'name phone');
        await message.populate({
            path: 'replyToMessageId',
            select: '_id text type mediaUrl caption waId sentBy',
            populate: {
                path: 'sentBy',
                select: 'name'
            }
        });

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
        const filter = { text: { $regex: escapeRegex(q), $options: 'i' } };
        if (chatId) filter.chatId = chatId;

        const [messages, total] = await Promise.all([
            Message.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('sentBy', 'name phone')
                .populate({
                    path: 'replyToMessageId',
                    select: '_id text type mediaUrl caption waId sentBy',
                    populate: {
                        path: 'sentBy',
                        select: 'name'
                    }
                }),
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

        await whatsappService.reactToMessage(chat.wabaId, chat.phoneNumberId, addressOf(chat), message.messageId, emoji);

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
            waId: chat.waId, bsuid: chat.bsuid,
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

        // Block retrying to blocked or opted-out contacts
        if (chat.contactId && (chat.contactId.isBlocked || chat.contactId.isOptedOut)) {
            return res.status(403).json({
                success: false,
                message: 'Cannot send messages to blocked or opted-out contacts.',
            });
        }

        const type = message.type;
        const mediaUrl = message.mediaUrl;
        const text = message.text;
        const caption = message.caption;
        let retryAsVoice = false;

        let waResult;
        if (type === 'text') {
            waResult = await whatsappService.sendTextMessage(chat.wabaId, chat.phoneNumberId, addressOf(chat), text);
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

                    if (type === 'audio' && message.metadata?.voice === true) {
                        try {
                            buffer = (await convertVoiceNoteForMeta(buffer)).buffer;
                            mimeType = 'audio/ogg';
                            retryAsVoice = true;
                        } catch (err) {
                            logger.warn(`Voice note retry: OGG/OPUS conversion failed, sending as audio file: ${err.message}`);
                            buffer = await convertAudioForMeta(buffer);
                            mimeType = 'audio/mp4';
                        }
                    } else if (type === 'audio') {
                        buffer = await convertAudioForMeta(buffer);
                        mimeType = 'audio/mp4'; // convertAudioForMeta produces AAC/M4A
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
                () => whatsappService.sendMediaMessage(chat.wabaId, chat.phoneNumberId, addressOf(chat), type, mediaIdToSend, caption || '', null, { voice: retryAsVoice })
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
                waId: chat.waId, bsuid: chat.bsuid,
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

/** Admins see every chat; staff only the chats assigned to them (same rule as the chat list). */
function canUseChat(user, chat) {
    if (!user || !chat) return false;
    if (['admin', 'superadmin'].includes(user.role)) return true;
    return String(chat.assignedTo?._id || chat.assignedTo || '') === String(user._id);
}

/**
 * POST /messages/:id/media/retry — download an inbound photo/sticker/voice note/file again when the
 * first download from WhatsApp failed (Meta keeps media ids for about 7 days).
 */
async function retryMedia(req, res, next) {
    try {
        const message = await Message.findById(req.params.id);
        if (!message) return res.status(404).json({ success: false, message: 'Message not found' });
        const chat = await Chat.findById(message.chatId).select('assignedTo wabaId');
        if (!canUseChat(req.user, chat)) return res.status(403).json({ success: false, message: 'Not allowed' });
        if (message.mediaUrl) return res.json(message); // already available
        if (message.direction !== 'inbound' || !message.mediaId) {
            return res.status(400).json({ success: false, message: 'This message has no media to download' });
        }
        const { processMediaAsync } = require('../services/webhook.service');
        const result = await processMediaAsync(chat, {
            mediaId: message.mediaId, wabaId: message.wabaId, mimeType: message.mimeType,
            fileName: message.fileName, messageId: message.messageId,
        }, message.type === 'sticker' ? 'sticker' : message.type);
        if (!result?.mediaUrl) {
            return res.status(502).json({ success: false, code: 'MEDIA_UNAVAILABLE', message: 'WhatsApp did not return the file. It may have expired (older than about 7 days).' });
        }
        message.mediaUrl = result.mediaUrl;
        message.metadata = { ...(message.metadata || {}), ...(result.metadata || {}), mediaPending: false };
        message.markModified('metadata');
        await message.save();
        try {
            require('../websocket/socket.server').getIO().emit('message:update', { chatId: String(message.chatId), message });
        } catch (_) { /* socket optional */ }
        res.json(message);
    } catch (e) {
        next(e);
    }
}

/**
 * POST /messages/:chatId/request-contact-info — ask a customer known only by their WhatsApp username /
 * business-scoped user ID to share their phone number (Meta interactive `request_contact_info`; the
 * customer taps a button and the reply arrives as a `contacts` message with origin "contact_request").
 * Only for customers WITHOUT a known phone number; subject to the 24-hour customer-service window.
 */
async function requestContactInfo(req, res, next) {
    try {
        const chat = await Chat.findById(req.params.chatId);
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
        if (!canUseChat(req.user, chat)) return res.status(403).json({ success: false, message: 'Not allowed' });
        if (chat.waId) return res.status(400).json({ success: false, code: 'PHONE_KNOWN', message: 'This customer\'s phone number is already known.' });
        if (!chat.bsuid) return res.status(400).json({ success: false, code: 'NO_RECIPIENT', message: 'This customer has no WhatsApp user ID.' });
        const text = String(req.body?.text || '').trim().slice(0, 1024)
            || 'Please share your phone number with us so our team can call you and keep your details up to date.';
        const waResult = await whatsappService.sendInteractiveMessage(chat.wabaId, chat.phoneNumberId, addressOf(chat), {
            type: 'request_contact_info',
            body: { text },
            action: { name: 'request_contact_info' },
        });
        const message = await Message.create({
            chatId: chat._id, wabaId: chat.wabaId, phoneNumberId: chat.phoneNumberId,
            messageId: waResult?.messages?.[0]?.id, waId: chat.waId, bsuid: chat.bsuid,
            direction: 'outbound', type: 'interactive', text, status: 'sent', sentBy: req.user._id,
            metadata: { kind: 'request_contact_info' },
        });
        try {
            require('../websocket/socket.server').getIO().emit('message:new', { chatId: chat._id, message: await message.populate('sentBy', 'name phone') });
        } catch (_) { /* socket optional */ }
        res.status(201).json(message);
    } catch (e) {
        next(e);
    }
}

module.exports = { requestContactInfo, send, sendBulk, search, react, markRead, addNote, deleteMsg, retry, retryMedia, canUseChat, convertVoiceNoteForMeta, VOICE_PLAY_ICON_MAX_BYTES };
