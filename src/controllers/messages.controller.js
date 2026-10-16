const { Message, Chat, Contact } = require('../models');
const whatsappService = require('../services/whatsapp.service');
const { logger } = require('../utils/logger');
const { addressOf } = require('../utils/waIdentity');

const { escapeRegex, phoneSearchTerm } = require('../utils/regex');
const media = require('../services/media/mediaPipeline');
const mediaMessages = require('../services/media/mediaMessageService');
const { convertVoiceNoteForMeta, VOICE_PLAY_ICON_MAX_BYTES } = require('../services/media/audioPrep');

/** A browser/app-local preview reference must never be treated as a server URL or a Meta media id. */
const LOCAL_REF_RE = /^(blob|data|file|content|filesystem):/i;

function wantsAsync(body) {
    return body?.async === true || body?.async === 'true';
}

/**
 * Prepare + upload + send one media message inline (the request waits). Used for clients that do not
 * opt into background sending, and by the legacy retry. Same preparation rules as the background job.
 * Returns { waResult, sentAsVoice, voiceNotice, pipeline } or throws.
 */
async function sendMediaInline({ chat, type, mediaUrl, caption, replyWamid, wantsVoice, voiceRejected, messageId }) {
    const timings = { acceptedAt: new Date().toISOString() };
    let mediaIdToSend = mediaUrl;
    let sentAsVoice = false;
    let voiceNotice;
    let prepareAction;
    if (mediaUrl.startsWith('http')) {
        let prepared;
        try {
            const r = await media.prepareAndUpload(chat, { type, mediaUrl, wantsVoice, voiceRejected });
            prepared = r.prepared;
            const up = r.up;
            mediaIdToSend = up.mediaId;
            sentAsVoice = prepared.sentAsVoice;
            voiceNotice = prepared.voiceNotice;
            prepareAction = prepared.action;
            Object.assign(timings, {
                sourceMs: prepared.timings.sourceMs,
                sourceLocal: prepared.timings.sourceLocal,
                prepareMs: prepared.timings.prepareMs,
                ...(prepared.timings.convertMs != null ? { convertMs: prepared.timings.convertMs } : {}),
                inputBytes: prepared.details.inputBytes,
                outputBytes: prepared.file.size,
                metaUploadMs: up.ms,
            });
            logger.info(`[media] ${type} ${prepared.action} (${prepared.details.inputBytes} -> ${prepared.file.size} bytes) prepare ${prepared.timings.prepareMs}ms, meta upload ${up.ms}ms`);
        } catch (err) {
            err.mediaStage = 'prepare';
            throw err;
        } finally {
            if (prepared) await prepared.cleanup();
        }
    }
    const result = await media.sendOnce({
        chat, to: addressOf(chat), type, mediaIdOrUrl: mediaIdToSend, caption, replyWamid, voice: sentAsVoice,
        bizOpaque: messageId ? `bjs:${messageId}:1` : undefined,
    });
    timings.sendMs = result.ms;
    return { result, sentAsVoice, voiceNotice, prepareAction, timings };
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

/** quotedMessage for an outbound reply - same shape as the webhook builds for inbound. */
async function buildQuotedMessage(replyToMessageId) {
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
    return quotedMessage;
}

/**
 * Background media send (client sent async:true). Stores the message + its job, answers 202 at once;
 * stages and the final result arrive via socket `message:pipeline` / `message:status` and are persisted.
 */
async function acceptAsyncMedia(req, res, { chat, type, mediaUrl, caption, replyToMessageId, wantsVoice }) {
    try {
        await mediaMessages.assertCapacity();
    } catch (e) {
        return res.status(e.statusCode || 503).json({ success: false, code: e.code || 'MEDIA_QUEUE_FULL', message: e.message });
    }
    const quotedMessage = await buildQuotedMessage(replyToMessageId);
    const message = await Message.create({
        chatId: chat._id,
        wabaId: chat.wabaId,
        phoneNumberId: chat.phoneNumberId,
        waId: chat.waId, bsuid: chat.bsuid,
        direction: 'outbound',
        type,
        mediaUrl,
        caption: caption || undefined,
        status: 'queued',
        sentBy: req.user._id,
        clientMessageId: req._clientMessageId || undefined,
        replyToMessageId: replyToMessageId || undefined,
        quotedMessage: quotedMessage || undefined,
        metadata: type === 'audio' ? { voice: wantsVoice } : undefined,
        pipeline: mediaMessages.newPipeline({ wantsVoice, clientTimings: req.body.clientTimings }),
    });
    try {
        await mediaMessages.enqueueProcess(message._id);
    } catch (e) {
        // Not durably queued: say so on the message and to the caller (never a fake acceptance).
        logger.error(`[media] could not queue message ${message._id}: ${e.message}`);
        await mediaMessages.failMessage(message._id, 'queue', new Error('The server could not queue this file. Please retry.'));
        return res.status(503).json({ success: false, code: 'MEDIA_QUEUE_UNAVAILABLE', message: 'The server could not queue this file. Please retry.', messageId: String(message._id) });
    }
    await Chat.findByIdAndUpdate(chat._id, { lastMessageAt: new Date(), lastStaffMessageAt: new Date() });
    await message.populate('sentBy', 'name phone');
    await message.populate({ path: 'replyToMessageId', select: '_id text type mediaUrl caption waId sentBy', populate: { path: 'sentBy', select: 'name' } });
    const { getIO } = require('../websocket/socket.server');
    getIO().emit('message:new', { chatId: chat._id, message });
    return res.status(202).json(message);
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
        } else if (media.MEDIA_TYPES.includes(type)) {
            if (!mediaUrl) return res.status(400).json({ success: false, message: 'mediaUrl is required for media messages' });
            if (LOCAL_REF_RE.test(String(mediaUrl))) {
                return res.status(400).json({ success: false, code: 'LOCAL_MEDIA_REF', message: 'mediaUrl is a local preview link, not an uploaded file. Upload the file first.' });
            }
            if (wantsAsync(req.body)) {
                return acceptAsyncMedia(req, res, { chat, type, mediaUrl, caption, replyToMessageId, wantsVoice });
            }
            const syncId = new (require('mongoose').Types.ObjectId)();
            let inline;
            try {
                inline = await sendMediaInline({ chat, type, mediaUrl, caption, replyWamid: metaMessageIdToReply, wantsVoice, voiceRejected: false, messageId: syncId });
            } catch (err) {
                if (err.mediaStage === 'prepare') {
                    logger.error(`Error processing/uploading media to Meta: ${err.message}`);
                    return res.status(500).json({ success: false, message: `Failed to upload media to WhatsApp: ${err.message}` });
                }
                throw err;
            }
            sentAsVoice = inline.sentAsVoice;
            voiceNotice = inline.voiceNotice;
            req._mediaSync = { id: syncId, timings: inline.timings, prepareAction: inline.prepareAction };
            if (!inline.result.ok) {
                if (inline.result.kind !== 'ambiguous') throw inline.result.error;
                // Meta may have accepted it: keep the message (unconfirmed) so the webhook can still match it.
                req._mediaSync.unconfirmed = true;
            } else {
                waResult = inline.result.raw;
            }
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
        const quotedMessage = await buildQuotedMessage(replyToMessageId);

        const ms = req._mediaSync;
        const message = await Message.create({
            ...(ms ? { _id: ms.id } : {}),
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
            status: ms?.unconfirmed ? 'queued' : 'sent',
            sentBy: req.user._id,
            clientMessageId: req._clientMessageId || undefined,
            ...(ms ? {
                pipeline: {
                    mode: 'sync',
                    stage: ms.unconfirmed ? 'unconfirmed' : 'sent',
                    active: false,
                    version: 1,
                    prepareAction: ms.prepareAction,
                    stageAt: new Date(),
                    timings: { ...ms.timings, ...(ms.unconfirmed ? { unconfirmedAt: new Date().toISOString() } : { sentAt: new Date().toISOString() }) },
                    ...(ms.unconfirmed ? { error: { stage: 'send', message: 'WhatsApp did not confirm the send. Checking...', at: new Date().toISOString(), willRetry: false } } : {}),
                },
            } : {}),
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
        } else if (media.MEDIA_TYPES.includes(type)) {
            if (message.pipeline?.active) {
                return res.status(409).json({ success: false, code: 'SEND_IN_PROGRESS', message: 'This file is still being sent.' });
            }
            if (wantsAsync(req.body)) {
                // Background retry: only the failed stage is redone (see mediaMessageService.retryAsync).
                const r = await mediaMessages.retryAsync(message._id);
                if (r.error === 409) return res.status(409).json({ success: false, code: 'NOT_FAILED', message: 'Only a failed message can be retried.' });
                if (r.error) return res.status(r.error).json({ success: false, message: 'This message cannot be retried.' });
                await r.message.populate('sentBy', 'name phone');
                return res.status(202).json(r.message);
            }
            if (!mediaUrl || LOCAL_REF_RE.test(mediaUrl)) {
                return res.status(400).json({ success: false, code: 'LOCAL_MEDIA_REF', message: 'This message has no uploaded file to send. Attach the file again.' });
            }
            // WhatsApp refused the voice file (131053 media processing): retry as a normal audio file.
            const voiceRejected = Number(message.errorCode) === 131053;
            let inline;
            try {
                inline = await sendMediaInline({
                    chat, type, mediaUrl, caption, replyWamid: null,
                    wantsVoice: type === 'audio' && message.metadata?.voice === true, voiceRejected,
                    messageId: message._id,
                });
            } catch (err) {
                if (err.mediaStage === 'prepare') {
                    logger.error(`Retry: Error processing/uploading media: ${err.message}`);
                    return res.status(500).json({ success: false, message: `Failed to upload media: ${err.message}` });
                }
                throw err;
            }
            if (!inline.result.ok) throw inline.result.error;
            retryAsVoice = inline.sentAsVoice;
            waResult = inline.result.raw;
            message.pipeline = {
                ...(message.pipeline || {}), mode: 'sync', stage: 'sent', active: false,
                version: (message.pipeline?.version || 0) + 1, retries: (message.pipeline?.retries || 0) + 1,
                prepareAction: inline.prepareAction, error: null,
                timings: { ...inline.timings, retriedAt: inline.timings.acceptedAt, sentAt: new Date().toISOString() },
            };
            message.markModified('pipeline');
        } else {
            return res.status(400).json({ success: false, message: `Cannot retry message type: ${type}` });
        }

        // Update the EXISTING message (no duplicate created)
        const newMsgId = waResult?.messages?.[0]?.id;
        message.messageId = newMsgId;
        message.status = 'sent';
        if (type === 'audio' && message.metadata?.voice === true && !retryAsVoice) {
            // Went out as an ordinary audio file this time: say so in the chat.
            message.metadata = { ...message.metadata, voice: false, voiceNotice: 'sent_as_audio_after_rejection' };
            message.markModified('metadata');
        }
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
                pipeline: { mode: 'bulk', stage: 'queued', active: false, version: 1, timings: { acceptedAt: new Date().toISOString() } },
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
