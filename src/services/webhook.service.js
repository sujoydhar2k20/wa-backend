const { Waba, Chat, Message, User, Contact, Product, ProductReplyLog, Rate } = require('../models');
const { getIO } = require('../websocket/socket.server');
const { logger } = require('../utils/logger');
const whatsappService = require('./whatsapp.service');
const botService = require('./bot.service');
const mediaService = require('./media.service');
const ocrService = require('./ocr.service');
const { uploadToVPS } = require('../utils/vpsUpload');
const aiFallbackService = require('./aiFallback.service');
const { parseInboundContent, previewText, parseReferral } = require('./inboundMessage');
const { isKnownStatus, statusGuard } = require('./messageStatus');
const { senderIdentity, resolveContact, resolveChat, applyUserIdChange } = require('./customerIdentity');
const { isBsuid, displayIdentity, addressOf, phoneDigits } = require('../utils/waIdentity');

const GST = 0.03;

/**
 * Calculate product price from rates (mirrors products.controller.js logic).
 */
function calculatePrice(product, rate) {
    const w = product.weight;
    const cat = product.category;
    if (!w || !cat || !rate) return undefined;

    if (cat === 'gold') {
        const karat = product.carat;
        const ratePerGram = karat ? (rate.gold?.[karat] || 0) : 0;
        if (!ratePerGram) return undefined;
        const making = product.makingCharge ? product.makingCharge / 100 : 0;
        const extra = product.extraCharge || 0;
        return Math.round((w * ratePerGram * (1 + making) + extra) * (1 + GST));
    }
    if (cat === 'silver') {
        if (!rate.silver) return undefined;
        const making = product.makingCharge ? product.makingCharge / 100 : 0;
        return Math.round(w * rate.silver * (1 + making) * (1 + GST));
    }
    if (cat === 'diamond') {
        if (!rate.diamond) return undefined;
        const extra = product.extraCharge || 0;
        return Math.round((w * rate.diamond + extra) * (1 + GST));
    }
    return undefined;
}

async function processWebhook(entry) {
    try {
        const wabaIdMeta = entry.id;
        const waba = await Waba.findOne({ wabaId: wabaIdMeta });
        if (!waba) {
            logger.error(`WABA not found for ID: ${wabaIdMeta}`);
            return;
        }

        for (const change of entry?.changes || []) {
            const value = change?.value;
            if (!value) continue;

            // A customer's business-scoped user ID changed.
            if (change.field === 'user_id_update' || Array.isArray(value.user_id_update)) {
                await require('./customerIdentity').processUserIdUpdate(value);
                continue;
            }

            if (value.statuses && value.statuses.length > 0) {
                for (const statusObj of value.statuses) {
                    await handleStatusUpdate(statusObj);
                }
            }

            if (!value.messages || !value.messages.length) continue;
            const metadata = value.metadata || {};
            const phoneNumberId = metadata.phone_number_id;
            const contacts = value.contacts || [];

            for (const msg of value.messages) {
                // One failing message must not stop the others in the same webhook.
                try {
                    await handleMessage(waba, phoneNumberId, msg, contacts);
                } catch (msgErr) {
                    await recordFailure({ entryId: wabaIdMeta, phoneNumberId, msg, contacts, metadata, error: msgErr });
                }
            }
        }
    } catch (error) {
        logger.error('Error processing webhook:', error);
    }
}

const RETRY_DELAYS_MIN = [1, 5, 15, 60, 180];

/** Keep a message whose processing failed (temporary errors), so it is retried and can be diagnosed. */
async function recordFailure({ entryId, phoneNumberId, msg, contacts, metadata, error }) {
    const errText = `${error?.name || 'Error'}: ${String(error?.message || error).slice(0, 300)}`;
    logger.error(`[webhook] processing failed for ${msg?.type} message ${msg?.id}: ${errText}`);
    try {
        const { WebhookFailure } = require('../models');
        const sender = (contacts || []).filter((c) => (msg?.from && c.wa_id === msg.from) || (msg?.from_user_id && c.user_id === msg.from_user_id));
        await WebhookFailure.updateOne(
            { kind: 'message', messageId: msg?.id },
            {
                $setOnInsert: {
                    kind: 'message', messageId: msg?.id, messageType: msg?.type, wabaMetaId: entryId, phoneNumberId,
                    payload: { msg, contacts: sender, metadata: metadata || {} },
                    attempts: 0, nextAttemptAt: new Date(Date.now() + RETRY_DELAYS_MIN[0] * 60e3),
                },
                $set: { error: errText },
            },
            { upsert: true },
        );
    } catch (e) {
        logger.error(`[webhook] could not record failed message ${msg?.id}: ${e.message}`);
    }
}

/** Agenda job: process failed messages again (safe: already-stored messages are skipped). */
async function retryFailedMessages({ now = new Date(), limit = 50 } = {}) {
    const { WebhookFailure } = require('../models');
    const due = await WebhookFailure.find({ kind: 'message', resolvedAt: null, gaveUpAt: null, nextAttemptAt: { $lte: now } })
        .sort({ nextAttemptAt: 1 }).limit(limit);
    let resolved = 0;
    for (const f of due) {
        const { msg, contacts, metadata } = f.payload || {};
        try {
            const waba = await Waba.findOne({ wabaId: f.wabaMetaId });
            if (!waba) throw new Error('WABA not found');
            await handleMessage(waba, f.phoneNumberId || metadata?.phone_number_id, msg, contacts || []);
            f.resolvedAt = new Date();
            resolved++;
            logger.info(`[webhook] retried message ${f.messageId}: processed`);
        } catch (e) {
            f.attempts += 1;
            f.error = `${e.name || 'Error'}: ${String(e.message).slice(0, 300)}`;
            if (f.attempts >= RETRY_DELAYS_MIN.length) {
                f.gaveUpAt = new Date();
                logger.error(`[webhook] giving up on message ${f.messageId} after ${f.attempts} retries: ${f.error}`);
            } else {
                f.nextAttemptAt = new Date(Date.now() + RETRY_DELAYS_MIN[f.attempts] * 60e3);
            }
        }
        await f.save();
    }
    return { checked: due.length, resolved };
}

async function handleMessage(waba, phoneNumberId, msg, contacts) {
    // Deduplication: skip if this Meta message ID was already processed
    const existingMsg = await Message.findOne({ messageId: msg.id });
    if (existingMsg) {
        logger.warn(`Duplicate webhook ignored for messageId: ${msg.id}`);
        return;
    }

    // Parse the content first (pure, see inboundMessage.js). Never log message content.
    const parsed = parseInboundContent(msg);
    logger.info(`[webhook] inbound ${msg.type}${parsed.type !== msg.type ? `->${parsed.type}` : ''} ${msg.id}${msg.context ? ' (reply)' : ''}`);

    // Sender identity: phone (wa_id) and/or business-scoped user ID (BSUID). Either may be missing
    // since WhatsApp usernames; a BSUID is never treated as a phone number.
    const identity = senderIdentity(msg, contacts);
    // Reply to our "share your phone number" request: the shared card is the customer's own number.
    // Only origin "contact_request" counts; a contact card forwarded by the customer is someone else.
    if (!identity.waId && identity.bsuid && msg.type === 'contacts') {
        const own = (msg.contacts || []).find((c) => c?.origin === 'contact_request');
        const ownPhone = phoneDigits(own?.phones?.find((p) => p?.wa_id)?.wa_id || own?.phones?.[0]?.phone);
        if (ownPhone) identity.waId = ownPhone;
    }
    const waId = identity.waId || undefined; // phone digits, when WhatsApp shared them
    const bsuid = identity.bsuid || undefined;
    const senderKey = waId || bsuid; // stable sender reference (reactions, logs)
    if (!senderKey) throw new Error('Inbound message has no sender identity (no from / from_user_id)');

    // Check if the number is globally blocked in AI settings (phone numbers only)
    try {
        const { AiSetting } = require('../models');
        const aiSettings = await AiSetting.findOne().lean();
        if (waId && aiSettings && aiSettings.blockedPhoneNumbers) {
            const blockedNumbers = aiSettings.blockedPhoneNumbers.split(',').map(n => n.trim()).filter(Boolean);
            if (blockedNumbers.includes(waId)) {
                logger.info(`Webhook: Message from globally blocked customer number ${waId} ignored early (AI settings blocklist).`);
                return;
            }
        }
    } catch (err) {
        logger.error('Error checking global blocked numbers in webhook:', err);
    }

    const profileName = identity.profileName || '';
    const fallbackName = displayIdentity({ waId, username: identity.username, bsuid });

    // Contact handling (matches phone OR BSUID; adds newly learned identities; no duplicates)
    const contact = await resolveContact(identity);

    // Duplicate Contact docs can exist for the same customer — the chat (and the UI badge) may point to
    // one document while this webhook loaded another. Match by every known identity so block/opt-out
    // state on ANY matching contact is honoured.
    const idOr = [];
    if (waId) idOr.push({ waId }, { phoneNumber: waId });
    if (bsuid) idOr.push({ bsuid });
    const numberMatch = { $or: idOr };

    // Block logic: discard inbound messages if this customer is blocked.
    const isContactBlocked = contact.isBlocked || await Contact.exists({ ...numberMatch, isBlocked: true });
    if (isContactBlocked) {
        logger.info(`Message from blocked contact ${senderKey} ignored.`);
        return;
    }

    // Auto opt-in: an inbound message means the customer re-engaged, so clear any opt-out
    // and re-enable messaging. Applied across duplicate contact docs for this number.
    const wasOptedOut = contact.isOptedOut || await Contact.exists({ ...numberMatch, isOptedOut: true });
    if (wasOptedOut) {
        await Contact.updateMany(numberMatch, { $set: { isOptedOut: false }, $unset: { optedOutAt: '' } });
        contact.isOptedOut = false;
        logger.info(`Auto opted-in contact ${senderKey} after inbound message.`);
    }

    // Find or create chat (by phone OR BSUID)
    let chat = await resolveChat(waba._id, identity);
    const isNewChat = !chat;
    // When the customer last wrote BEFORE this message (read before it is overwritten below).
    // The bot's "first message of the day" trigger needs it.
    const previousCustomerMessageAt = chat?.lastCustomerMessageAt || null;

    if (!chat) {
        chat = new Chat({
            wabaId: waba._id,
            phoneNumberId,
            phoneNumber: waId,
            waId,
            bsuid,
            contactId: contact._id,
            status: 'open',
            isUnread: true,
            lastCustomerMessageAt: new Date(),
        });
    } else if (!chat.contactId) {
        chat.contactId = contact._id;
    }

    // The customer's BSUID changed (system notice): move the new one onto this customer.
    if (parsed.isSystemEvent && parsed.metadata?.systemType === 'user_changed_user_id' && isBsuid(parsed.metadata.user_id)) {
        const newId = parsed.metadata.user_id;
        await applyUserIdChange({ previous: bsuid, current: newId, waId });
        if (!(await Chat.exists({ wabaId: waba._id, bsuid: newId, _id: { $ne: chat._id } }))) chat.bsuid = newId;
    }

    // Auto-assign new chat to the least-loaded active staff member on this WABA (round-robin by open chat count)
    const { isMonthly } = require('../utils/tag');
    const isMonthlyCustomer = await isMonthly({ chat, contact });
    if (isNewChat && !chat.assignedTo && !isMonthlyCustomer) {
        try {
            const staffMembers = await User.find({
                isActive: true,
                role: 'staff',
                assignedWabaId: waba._id,
            }).select('_id').lean();

            if (staffMembers.length > 0) {
                // Count open chats per staff member, pick the one with fewest
                const chatCounts = await Promise.all(
                    staffMembers.map(async (staff) => {
                        const count = await Chat.countDocuments({
                            assignedTo: staff._id,
                            status: { $ne: 'closed' },
                        });
                        return { staffId: staff._id, count };
                    })
                );

                // Sort by count ascending, pick the least loaded staff
                chatCounts.sort((a, b) => a.count - b.count);
                const leastLoaded = chatCounts[0];
                chat.assignedTo = leastLoaded.staffId;
                logger.info(
                    `Auto-assigned new chat (${senderKey}) to staff ${leastLoaded.staffId} (open chats: ${leastLoaded.count})`
                );
            }
        } catch (err) {
            logger.error('Error auto-assigning staff to chat:', err);
        }
    }

    // Update chat metadata. WhatsApp system notices (number/ID changes) are not customer messages:
    // they neither open the 24-hour window nor reopen or mark the chat unread.
    chat.lastMessageAt = new Date();
    let wasReopened = false;
    if (!parsed.isSystemEvent) {
        chat.lastCustomerMessageAt = new Date();
        chat.isUnread = true;

        // Set WhatsApp Session Expiry exactly 24 hours from the incoming message timestamp
        chat.sessionExpiresAt = new Date((msg.timestamp * 1000) + (24 * 60 * 60 * 1000));

        // Detect a reopen: an existing chat that was closed and is now receiving a new customer message.
        wasReopened = !isNewChat && chat.status === 'closed';
        if (chat.status === 'closed') chat.status = 'open';
    }

    // Click-to-WhatsApp ad / post the customer came from. The first one is kept for good; later ones
    // (the customer tapped another ad) update lastReferral and the count. Each message keeps its own.
    const referral = parseReferral(msg.referral);
    if (referral) {
        const stamped = { ...referral, messageId: msg.id, receivedAt: new Date(msg.timestamp * 1000) };
        if (!chat.firstReferral?.receivedAt) chat.firstReferral = stamped;
        chat.lastReferral = stamped;
        chat.referralCount = (chat.referralCount || 0) + 1;
        logger.info(`[webhook] referral ${referral.sourceType || 'unknown'} ${referral.sourceId || ''} on ${msg.id}`);
    }

    await chat.save();

    // Create message
    const messageData = {
        chatId: chat._id,
        wabaId: waba._id,
        phoneNumberId,
        messageId: msg.id,
        waId,
        bsuid,
        direction: 'inbound',
        type: parsed.type,
        status: 'delivered',
        timestamp: new Date(msg.timestamp * 1000),
    };
    if (parsed.text) messageData.text = parsed.text;
    if (parsed.metadata) messageData.metadata = { ...parsed.metadata };
    if (referral) messageData.metadata = { ...(messageData.metadata || {}), referral };
    if (parsed.location) messageData.location = parsed.location;

    // Preserve reply threading for inbound customer replies.
    // WhatsApp provides the parent wa message ID in context.id (NOT context.message_id).
    // We also capture the quoted message preview details for display in the UI.
    const repliedWaMessageId = msg.context?.id;
    if (repliedWaMessageId) {
        const parentMessage = await Message.findOne({ messageId: repliedWaMessageId }).select('_id text type caption waId sentBy mediaUrl fileName');
        
        if (parentMessage?._id) {
            messageData.replyToMessageId = parentMessage._id;
            
            // Extract sender name from the parent message
            let senderName = '';
            if (parentMessage.sentBy) {
                // Staff-sent message: populate sentBy to get the name
                const parentWithSender = await Message.findById(parentMessage._id).populate('sentBy', 'name');
                senderName = parentWithSender.sentBy?.name || 'Staff';
            } else {
                // Customer-sent message
                senderName = profileName || fallbackName;
            }
            
            // Build the quoted message preview data
            // For text messages: use text
            // For media messages: use caption as the main text display
            // Store raw content, frontend handles formatting
            const previewText = parentMessage.text || parentMessage.caption || '';
            
            messageData.quotedMessage = {
                messageId: repliedWaMessageId,
                text: previewText,
                type: parentMessage.type,
                waId: parentMessage.waId,
                senderName: senderName,
                caption: parentMessage.caption || null,
                mediaUrl: parentMessage.mediaUrl || null,
                fileName: parentMessage.fileName || null,
            };
            
        }
    }

    // Handle message types
    if (msg.type === 'reaction') {
        const targetMessageId = msg.reaction.message_id;
        const emoji = msg.reaction.emoji;

        const targetMsg = await Message.findOne({ messageId: targetMessageId });
        if (targetMsg) {
            targetMsg.reactions = targetMsg.reactions.filter(r => r.by !== senderKey && !(bsuid && r.by === bsuid));
            if (emoji) {
                targetMsg.reactions.push({ emoji, by: senderKey });
            }
            await targetMsg.save();

            try {
                const io = getIO();
                io.emit('message:reaction', {
                    chatId: chat._id,
                    messageId: targetMsg._id,
                    reactions: targetMsg.reactions
                });
            } catch (e) {
                logger.warn('Socket emit failed for reaction:', e.message);
            }
        }

        // Reactions are attached to existing messages, not saved as standalone messages
        return;
    } else if (parsed.media) {
        messageData.mediaId = parsed.media.id;
        messageData.mimeType = parsed.media.mimeType;
        messageData.caption = parsed.media.caption;
        if (parsed.media.fileName) {
            messageData.fileName = parsed.media.fileName;
        }

        // Process media download/upload synchronously before saving the message
        try {
            const mediaResult = await processMediaAsync(chat, messageData, parsed.media.field);
            if (mediaResult?.mediaUrl) {
                messageData.mediaUrl = mediaResult.mediaUrl;
            } else {
                // Download/upload failed: keep the media id so staff can retry later (Meta keeps it ~7 days).
                messageData.metadata = { ...(messageData.metadata || {}), mediaPending: true };
            }
            if (mediaResult?.metadata) {
                messageData.metadata = {
                    ...(messageData.metadata || {}),
                    ...mediaResult.metadata,
                };
            }
        } catch (err) {
            logger.error(`Failed to process media ${msg.type} for message ${msg.id}: ${err.message}`);
            messageData.metadata = { ...(messageData.metadata || {}), mediaPending: true };
        }
    } else if (parsed.metadata?.kind === 'call_permission_reply') {
        // Customer allowed/declined WhatsApp calls from the business (or allowed automatically by calling us)
        const reply = parsed.metadata.call_permission_reply;
        const accepted = String(reply.response).toLowerCase() === 'accept';
        messageData.text = accepted
            ? `📞 Customer allowed WhatsApp calls${reply.is_permanent ? ' (permanently)' : ''}`
            : '📞 Customer declined WhatsApp calls';
        try {
            await require('./calls/permissions').recordReply({ wabaId: waba._id, phoneNumberId, waId, reply });
        } catch (permErr) {
            logger.error(`Failed to record call permission reply for message ${msg.id}: ${permErr.message}`);
        }
    }
    // Add other types as needed

    // Idempotent insert: check by WhatsApp message ID before creating.
    // WhatsApp retries webhook delivery when the server responds slowly,
    // which would otherwise create duplicate messages in the DB.
    const existingMessage = await Message.findOne({ messageId: msg.id });
    if (existingMessage) {
        logger.warn(`Duplicate inbound webhook for messageId ${msg.id}, skipping.`);
        return;
    }

    let message;
    try {
        message = await Message.create(messageData);
    } catch (createErr) {
        // E11000 = duplicate key error: two simultaneous webhook retries raced past
        // the findOne check above. The first insert won — just bail out silently.
        if (createErr.code === 11000) {
            logger.warn(`Concurrent duplicate inbound webhook for messageId ${msg.id}, skipping.`);
            return;
        }
        if (createErr.name !== 'ValidationError') throw createErr; // DB down etc.: recorded and retried by processWebhook
        // The content did not fit our schema: never lose the message, store a readable placeholder.
        logger.error(`[webhook] ${msg.type} message ${msg.id} failed validation (${Object.keys(createErr.errors || {}).join(', ')}); stored as placeholder`);
        message = await Message.create({
            chatId: messageData.chatId, wabaId: messageData.wabaId, phoneNumberId, messageId: msg.id, waId, bsuid,
            direction: 'inbound', type: 'unsupported', status: 'delivered',
            text: messageData.text || '⚠️ The customer sent a message that could not be stored. Please check WhatsApp on the phone.',
            metadata: { kind: 'unsupported', originalType: msg.type, reason: 'validation' },
        });
    }

    // Send push notification & save to Notification Center
    try {
        // Skip if Chat DND is enabled; WhatsApp system notices never notify
        if (parsed.isSystemEvent) {
            // nothing
        } else if (chat.isDnd) {
            logger.info(`Notification skipped for DND chat ${chat._id}`);
        } else {
            const notificationService = require('./notification.service');
            let userIdsToNotify = [];

            if (chat.assignedTo) {
                // Notify the assigned staff
                userIdsToNotify.push(chat.assignedTo.toString());
            } else {
                // Notify superadmins/admins who can see unassigned chats
                const admins = await User.find({
                    isActive: true,
                    role: { $in: ['admin', 'superadmin'] }
                }).select('_id').lean();
                userIdsToNotify = admins.map(u => u._id.toString());
            }

            if (userIdsToNotify.length > 0) {
                const displayName = profileName || contact.name || fallbackName;
                const notificationType = isNewChat ? 'new_chat' : 'unread_reminder';
                
                // Construct WhatsApp-like title and body
                const title = displayName;
                let body = message.type === 'text' ? (message.text || '') : previewText({ ...parsed, text: message.text });

                // Truncate body if it is too long
                const maxLen = 300;
                if (body.length > maxLen) {
                    body = body.substring(0, maxLen) + '...';
                }

                await notificationService.notifyMultipleUsers(userIdsToNotify, {
                    type: notificationType,
                    title,
                    body,
                    metadata: { chatId: chat._id.toString() }
                });
                
                // Update lastNotificationAt to track repeat intervals
                chat.lastNotificationAt = new Date();
                await chat.save();
            }
        }
    } catch (notifErr) {
        logger.error(`Error triggering notification: ${notifErr.message}`);
    }

    // A message WhatsApp generated because the customer is calling (e.g. the automatic call permission):
    // keep it in the chat, but no auto-replies or bot flows - a staff member is taking the call.
    const callEvents = require('./calls/callEvents');
    let isCallGenerated = callEvents.isCallGeneratedMessage({
        msg,
        messageData,
        recentInboundCall: (msg.type === 'unsupported' || msg.type === 'system') && waId
            ? await callEvents.hasRecentInboundCall({ phoneNumberId, waId })
            : false,
    });
    if (parsed.isSystemEvent) {
        isCallGenerated = true; // same treatment: stored, no bot / auto replies
    }
    if (isCallGenerated) {
        logger.info(`[bot] skipped for call-generated/system ${msg.type} message ${msg.id} (chat ${chat._id})`);
    }

    // Product code auto-reply + AI fallback
    if (isCallGenerated) {
        // nothing: no automatic replies for call events
    } else if (msg.type === 'text' && msg.text?.body) {
        const textBody = msg.text.body;
        const codeCandidates = extractProductCodeCandidates(textBody);
        const directCode = detectProductCode(textBody);

        if (directCode || codeCandidates.length > 0) {
            // Looks like a product code → try product lookup
            handleProductCodeReply(waba, phoneNumberId, chat, message, textBody, 'text')
                .then(async () => {
                    // After product code attempt, if no product was found and it's a sentence,
                    // try AI fallback
                    const { product } = await findProductByCandidates(codeCandidates);
                    if (!product && textBody.includes(' ')) {
                        aiFallbackService.handleAiFallback(waba, phoneNumberId, chat, message, textBody, whatsappService)
                            .catch(e => logger.error('AI Fallback error:', e.message));
                    }
                })
                .catch(e => logger.error('Product code auto-reply error:', e.message));
        } else {
            // Not a product code → try AI fallback directly
            aiFallbackService.handleAiFallback(waba, phoneNumberId, chat, message, textBody, whatsappService)
                .catch(e => logger.error('AI Fallback error:', e.message));
        }
    } else if (msg.type === 'image') {
        const ocrText = message?.metadata?.ocr?.text || '';
        if (ocrText) {
            handleProductCodeReply(waba, phoneNumberId, chat, message, ocrText, 'image_ocr')
            .catch(e => logger.error('Product code auto-reply error:', e.message));
        }
    }
    // Bot flow execution (fire-and-forget)
    const msgText = parsed.botText || (msg.type === 'interactive' ? messageData.text : '');

    // When a chat is reopened, cancel any stale bot executions left from previous flows
    // (e.g., close-conversation delay timers) BEFORE processing new flows.
    if (wasReopened) {
        try {
            await botService.cancelStaleExecutions(chat._id);
        } catch (e) {
            logger.error('Failed to cancel stale bot executions on reopen:', e.message);
        }
    }

    // One bot decision per customer message. For a brand-new or reopened chat this also
    // covers "open conversation" flows, so the customer never gets two welcome flows.
    logger.info(`[bot] incoming message for chat ${chat._id} (${senderKey}): isNewChat=${isNewChat}, wasReopened=${wasReopened}`);
    if (!isCallGenerated) {
        botService.processIncomingMessage({
            waba, phoneNumberId, chat, message, text: msgText || '',
            isNewChat, wasReopened, previousCustomerMessageAt,
        }).catch(e => logger.error('Bot execution error:', e.message));
    }

    // Emit socket event
    try {
        const io = getIO();
        io.emit('message:new', {
            chatId: chat._id,
            message
        });

        const populatedChat = await Chat.findById(chat._id)
            .populate('contactId', 'name nameOnWhatsApp nickname profilePicture isOptedOut isBlocked customFields')
            .populate('assignedTo', 'name phone')
            .populate('wabaId', 'businessName phoneNumbers')
            .populate('collaborators', 'name phone')
            .populate('tags', 'name color')
            .lean();

        // Also notify about chat update (unread count, last msg)
        io.emit('chat:update', {
            chatId: chat._id.toString(),
            chat: {
                ...populatedChat,
                lastMessage: message
            }
        });
    } catch (e) {
        logger.warn('Socket emit failed:', e.message);
    }
}

async function handleStatusUpdate(statusObj) {
    try {
        const messageId = statusObj.id;
        const status = statusObj.status; // 'sent', 'delivered', 'read', 'failed'
        const timestamp = new Date(statusObj.timestamp * 1000);

        logger.info(`Received status update for Meta ID: ${messageId} -> ${status}`);

        // Extract error details when Meta reports failure
        let errorCode = null;
        let errorMessage = null;
        if (status === 'failed' && statusObj.errors && statusObj.errors.length > 0) {
            const metaError = statusObj.errors[0];
            errorCode = metaError.code;
            errorMessage = metaError.title || metaError.message || 'Unknown error';
            if (metaError.error_data?.details) {
                errorMessage += ` - ${metaError.error_data.details}`;
            }
            logger.error(`Meta delivery failure for ${messageId}: code=${errorCode}, message=${errorMessage}`, statusObj.errors);
        }

        // Retry up to 3 times with a 500 ms delay to handle the race where WhatsApp
        // delivers a status webhook before our own DB write for the outbound message
        // has completed (common for 'sent' status on fast networks).
        let message = null;
        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 500;

        // Build update payload
        const updatePayload = {
            status: status,
            statusTimestamp: timestamp,
        };
        // Per-status time (shown in the message timing details). Only known statuses reach the update below.
        if (/^[a-z]+$/.test(String(status))) updatePayload[`statusTimes.${status}`] = timestamp;
        // Only overwrite error fields when status is 'failed'
        if (status === 'failed') {
            updatePayload.errorCode = errorCode;
            updatePayload.errorMessage = errorMessage;
        }

        if (!isKnownStatus(status)) {
            logger.warn(`Status update: unknown status "${status}" for ${messageId}, ignored`);
            return;
        }
        // The message may not be stored yet (status can arrive before our own write completes).
        let exists = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            exists = await Message.exists({ messageId });
            if (exists) break;
            if (attempt < MAX_RETRIES) {
                logger.warn(`Status update: message not found for Meta ID ${messageId} (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY_MS}ms...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            }
        }
        if (!exists && statusObj.biz_opaque_callback_data) {
            // A media send whose HTTP response was lost (timeout): Meta echoes our message id back.
            try {
                const { reconcileFromWebhook } = require('./media/mediaMessageService');
                if (await reconcileFromWebhook(statusObj)) exists = await Message.exists({ messageId });
            } catch (recErr) {
                logger.warn(`Status update: callback-data reconciliation failed for ${messageId}: ${recErr.message}`);
            }
        }
        if (exists) {
            // Only move forward: a late "delivered" never replaces "read"/"played", duplicates are no-ops.
            message = await Message.findOneAndUpdate(
                { messageId, ...statusGuard(status) },
                { $set: updatePayload },
                { new: true }
            );
            if (!message) {
                logger.info(`Status update: ${messageId} already past "${status}", ignored`);
                return;
            }
        }

        if (message) {
            logger.info(`Successfully updated message ${message._id} to ${status}`);
            
            // IMPORTANT: Also update the corresponding BroadcastMessage if this is from a broadcast
            try {
                const { BroadcastMessage, Broadcast, BroadcastListMember } = require('../models');
                const broadcastMessage = status === 'played' ? null : await BroadcastMessage.findOne({ messageId });
                if (broadcastMessage) {
                    const broadcastUpdatePayload = { status: status };
                    if (status === 'failed') {
                        broadcastUpdatePayload.errorCode = errorCode;
                        broadcastUpdatePayload.errorMessage = errorMessage;
                    }
                    await BroadcastMessage.findByIdAndUpdate(
                        broadcastMessage._id,
                        { $set: broadcastUpdatePayload }
                    );
                    logger.info(`Also updated broadcast message ${broadcastMessage._id} to ${status}`);
                    
                    // Update BroadcastListMember status
                    const broadcast = await Broadcast.findById(broadcastMessage.broadcastId).select('broadcastListId');
                    if (broadcast) {
                        await BroadcastListMember.findOneAndUpdate(
                            { broadcastListId: broadcast.broadcastListId, phoneNumber: broadcastMessage.phoneNumber },
                            { $set: { status: status } }
                        );
                    }
                    
                    // Re-aggregate and update stats
                    if (['delivered', 'read', 'failed', 'sent'].includes(status)) {
                        const statsObj = await BroadcastMessage.aggregate([
                            { $match: { broadcastId: broadcastMessage.broadcastId } },
                            { $group: { _id: "$status", count: { $sum: 1 } } }
                        ]);
                        const statsUpdate = {};
                        statsObj.forEach(s => {
                            if (['sent', 'delivered', 'read', 'failed'].includes(s._id)) {
                                statsUpdate[`statistics.${s._id}`] = s.count;
                            }
                        });

                        if (Object.keys(statsUpdate).length > 0) {
                            const updatedBroadcast = await Broadcast.findByIdAndUpdate(broadcastMessage.broadcastId, { $set: statsUpdate }, { new: true });
                            try {
                                const io = getIO();
                                io.emit('broadcast:update', updatedBroadcast);
                            } catch (emitErr) {
                                logger.warn('Socket emit failed for broadcast update:', emitErr.message);
                            }
                        }
                    }
                    
                    // Emit broadcast message status
                    try {
                        const io = getIO();
                        io.emit('broadcast:message:status', {
                            broadcastId: broadcastMessage.broadcastId,
                            messageId: broadcastMessage._id,
                            status: status,
                            ...(status === 'failed' && { errorCode, errorMessage })
                        });
                    } catch (emitError) {
                        logger.warn('Socket emit failed for broadcast message status:', emitError.message);
                    }
                }
            } catch (bmErr) {
                logger.warn('Failed to update broadcast message:', bmErr.message);
            }
            
            // Emit socket event for frontend to update checkmarks
            try {
                const io = getIO();
                io.emit('message:status', {
                    chatId: message.chatId.toString(),
                    messageId: message._id.toString(), // Mongo ID used by frontend
                    waMessageId: messageId,             // Meta ID
                    status: status,
                    ...(status === 'failed' && { errorCode, errorMessage }),
                });
            } catch (emitError) {
                logger.warn('Socket emit failed for message status:', emitError.message);
            }

            // Sync status to parent Chat if this message is the latest message in the chat
            try {
                const latestMsg = await Message.findOne({ chatId: message.chatId }).sort({ createdAt: -1 }).select('_id');
                if (latestMsg && latestMsg._id.toString() === message._id.toString()) {
                    const updatedChat = await Chat.findByIdAndUpdate(
                        message.chatId,
                        { $set: { lastMessageStatus: status } },
                        { new: true }
                    )
                    .populate('contactId', 'name nameOnWhatsApp nickname profilePicture isOptedOut isBlocked customFields')
                    .populate('assignedTo', 'name phone')
                    .populate('wabaId', 'businessName phoneNumbers')
                    .populate('collaborators', 'name phone')
                    .populate('tags', 'name color')
                    .lean();

                    if (updatedChat) {
                        const io = getIO();
                        io.emit('chat:update', {
                            chatId: message.chatId.toString(),
                            chat: {
                                ...updatedChat,
                                lastMessage: message.toObject ? message.toObject() : message
                            }
                        });
                    }
                }
            } catch (chatUpdateErr) {
                logger.error('Failed to sync lastMessageStatus to Chat:', chatUpdateErr);
            }
        } else {
            const { BroadcastMessage, Broadcast, BroadcastListMember } = require('../models');
            const broadcastUpdatePayload = { status: status };
            if (status === 'failed') {
                broadcastUpdatePayload.errorCode = errorCode;
                broadcastUpdatePayload.errorMessage = errorMessage;
            }
            const broadcastMessage = await BroadcastMessage.findOneAndUpdate(
                { messageId },
                { $set: broadcastUpdatePayload } // 'sent', 'delivered', 'read', 'failed'
            );

            if (broadcastMessage) {
                logger.info(`Successfully updated broadcast message ${broadcastMessage._id} to ${status}`);

                // Find Broadcast to get the list ID
                const broadcast = await Broadcast.findById(broadcastMessage.broadcastId).select('broadcastListId');
                if (broadcast) {
                    await BroadcastListMember.findOneAndUpdate(
                        { broadcastListId: broadcast.broadcastListId, phoneNumber: broadcastMessage.phoneNumber },
                        { $set: { status: status } }
                    );
                }

                // Re-aggregate and update stats safely
                if (['delivered', 'read', 'failed', 'sent'].includes(status)) {
                    const statsObj = await BroadcastMessage.aggregate([
                        { $match: { broadcastId: broadcastMessage.broadcastId } },
                        { $group: { _id: "$status", count: { $sum: 1 } } }
                    ]);
                    const statsUpdate = {};
                    statsObj.forEach(s => {
                        if (['sent', 'delivered', 'read', 'failed'].includes(s._id)) {
                            statsUpdate[`statistics.${s._id}`] = s.count;
                        }
                    });

                    if (Object.keys(statsUpdate).length > 0) {
                        const updatedBroadcast = await Broadcast.findByIdAndUpdate(broadcastMessage.broadcastId, { $set: statsUpdate }, { new: true });

                        try {
                            const io = getIO();
                            io.emit('broadcast:update', updatedBroadcast);
                        } catch (emitError) {
                            logger.warn('Socket emit failed for broadcast update:', emitError.message);
                        }
                    }
                }

                try {
                    const io = getIO();
                    io.emit('broadcast:message:status', {
                        broadcastId: broadcastMessage.broadcastId,
                        messageId: broadcastMessage._id,
                        status: status,
                        ...(status === 'failed' && { errorCode, errorMessage })
                    });
                } catch (emitError) {
                    logger.warn('Socket emit failed for broadcast message status:', emitError.message);
                }
            } else {
                logger.warn(`No message found in DB for Meta ID: ${messageId} after ${MAX_RETRIES} attempts`);
            }
        }
    } catch (e) {
        logger.error('Error handling status update:', e.message);
    }
}

/**
 * Detect if a WhatsApp text message looks like a product code or SKU.
 * Codes are short, contain no spaces (e.g. "32/238", "GOLD-001", "SLV_45").
 */
function detectProductCode(text) {
    const trimmed = text.trim();
    // Max 40 chars, no whitespace, contains at least one alphanumeric char
    if (trimmed.length === 0 || trimmed.length > 40) return null;
    if (/\s/.test(trimmed)) return null;
    if (!/[a-zA-Z0-9]/.test(trimmed)) return null;
    return trimmed;
}

function extractProductCodeCandidates(text) {
    if (!text || typeof text !== 'string') return [];

    const normalized = text
        .replace(/[|]/g, '/')
        .replace(/[\r\n\t]+/g, ' ');

    const candidates = new Set();

    // Full text token if user sends only one short code
    const direct = detectProductCode(normalized);
    if (direct) candidates.add(direct);

    // Revised regex with word boundaries
    const regex = /\b[A-Za-z]{2,4}\s+\d+(?:[\/_-][A-Za-z0-9]+)+\b|\b[A-Za-z0-9]+(?:[\/_-][A-Za-z0-9]+)+\b|\b[A-Za-z]{2,}\d+[A-Za-z0-9]*\b/g;
    const matches = normalized.match(regex) || [];
    for (const raw of matches) {
        const cleaned = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').replace(/\s+/g, ' ');
        
        // If there's a space (e.g. "BJS 20/112"), also extract the sub-code after the space (e.g. "20/112")
        if (cleaned.includes(' ')) {
            const parts = cleaned.split(' ');
            const subCode = parts[parts.length - 1];
            const subCodeClean = detectProductCode(subCode);
            if (subCodeClean) candidates.add(subCodeClean);
        }

        const code = detectProductCode(cleaned);
        if (code) candidates.add(code);

        // Also add compact variant (handles OCR that inserts spaces: "BJS 20/112")
        const compact = cleaned.replace(/\s+/g, '');
        const compactCode = detectProductCode(compact);
        if (compactCode) candidates.add(compactCode);
    }

    return Array.from(candidates);
}

function normalizeNumericLikeToken(token) {
    const map = {
        o: '0', O: '0',
        i: '1', I: '1', l: '1', L: '1', '|': '1',
        s: '5', S: '5',
        z: '2', Z: '2',
        b: '8', B: '8',
        g: '6', G: '6',
        q: '9', Q: '9',
    };

    let out = '';
    for (const ch of token) {
        if (/\d/.test(ch)) out += ch;
        else if (ch === 'm' || ch === 'M') out += '11'; // common OCR confusion for "11"
        else if (map[ch]) out += map[ch];
    }
    return out;
}

function buildFlexibleCodeRegex(code) {
    const cleaned = String(code || '').trim();
    const chunks = cleaned.split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (!chunks.length) return null;
    const escapedChunks = chunks.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^${escapedChunks.join('[\\s/_-]*')}$`, 'i');
}

function expandCodeVariants(candidate) {
    const variants = new Set();
    if (!candidate) return [];

    variants.add(candidate);

    const compact = candidate.replace(/\s+/g, '');
    variants.add(compact);

    // Prefix OCR fixes (Bus -> BJS)
    variants.add(compact.replace(/^bus/i, 'bjs'));
    variants.add(compact.replace(/^bis/i, 'bjs'));

    const parts = compact.split(/[\/_-]+/).filter(Boolean);
    if (parts.length >= 2) {
        const normalizedParts = parts.map((p, idx) => {
            if (/^\d+$/.test(p)) return p;
            const numericLike = normalizeNumericLikeToken(p);
            // Prefer numeric correction for right side token (e.g. "m2" -> "112")
            if (idx > 0 && numericLike) return numericLike;
            return p;
        });
        variants.add(normalizedParts.join('/'));

        // If first part is prefix+digits (e.g. BJS20), also try split-prefix form: "BJS 20/112"
        const prefixDigitMatch = normalizedParts[0].match(/^([A-Za-z]+)(\d+)$/);
        if (prefixDigitMatch) {
            variants.add(`${prefixDigitMatch[1]} ${prefixDigitMatch[2]}/${normalizedParts.slice(1).join('/')}`);
        }

        // If first part has prefix+digits like "BJS20", also try only digits: "20/112"
        const firstDigits = (normalizedParts[0].match(/\d+/g) || []).join('');
        if (firstDigits && normalizedParts.length > 1) {
            variants.add([firstDigits, ...normalizedParts.slice(1)].join('/'));
        }
    }

    // Compact OCR form with no separators, e.g. "Bis20m2" -> "BJS 20/112", "20/112"
    const compactMixed = compact.match(/^([A-Za-z]{2,})(\d+)([A-Za-z0-9]{1,6})$/);
    if (compactMixed) {
        const prefixRaw = compactMixed[1];
        const leftNum = compactMixed[2];
        const rightRaw = compactMixed[3];

        const prefix = prefixRaw.replace(/^bis/i, 'bjs').replace(/^bus/i, 'bjs');
        const rightNum = normalizeNumericLikeToken(rightRaw);
        if (rightNum) {
            variants.add(`${prefix} ${leftNum}/${rightNum}`);
            variants.add(`${prefix}${leftNum}/${rightNum}`);
            variants.add(`${leftNum}/${rightNum}`);
        }
    }

    return Array.from(variants).filter(v => {
        const trimmed = v.trim();
        return trimmed.length > 0 && trimmed.length <= 40 && /[a-zA-Z0-9]/.test(trimmed);
    });
}

async function findProductByCandidates(candidates) {
    for (const candidate of candidates) {
        const expandedVariants = expandCodeVariants(candidate);
        for (const variant of expandedVariants) {
            const codeRegex = buildFlexibleCodeRegex(variant);
            if (!codeRegex) continue;
            const product = await Product.findOne({ $or: [{ code: codeRegex }, { sku: codeRegex }] }).lean();
            if (product) {
                return { product, matchedCode: variant };
            }
        }
    }
    return { product: null, matchedCode: null };
}

/**
 * Look up a product by code or SKU and auto-reply with its details.
 */
async function handleProductCodeReply(waba, phoneNumberId, chat, message, text, source = 'text') {
    const candidates = extractProductCodeCandidates(text);
    if (!candidates.length) return;

    const { product, matchedCode: code } = await findProductByCandidates(candidates);

    if (!product) {
        // No match → silent, no reply
        return;
    }

    // Compute latest price using current rates
    let displayPrice = product.price;
    try {
        const rate = await Rate.findOne().lean();
        if (rate) {
            const computed = calculatePrice(product, rate);
            if (computed !== undefined) displayPrice = computed;
        }
    } catch (_) {
        // Use stored price if rate lookup fails
    }

    const CATEGORY_HEADER = {
        gold:    '🏅 Gold Product Details',
        silver:  '🥈 Silver Product Details',
        diamond: '💎 Diamond Product Details',
    };

    const searchCode = String(product.code || '');
    const searchParam = encodeURIComponent(searchCode).replace(/%2F/g, '/');

    // Prefer explicit net weight fields when available (some imports store gross/net separately)
    const displayWeightVal = product.netWeight ?? (product.metadata && product.metadata.netWeight) ?? product.weight;
    // Do not include weight line for silver products
    const isSilver = (product.category || '').toString().toLowerCase() === 'silver';
    const weightLine = (!isSilver && displayWeightVal != null) ? `⚖️ Weight: ${displayWeightVal}gm` : null;

    const lines = [
        CATEGORY_HEADER[product.category] || `📦 Product Details`,
        `📋 Code: ${product.code}`,
        weightLine,
        displayPrice != null ? `💵 Approx: ₹${displayPrice.toLocaleString()}` : null,
        ``,
        `🛒 Buy Now: https://biswakarmagold.com/products?search=${searchParam}`,
    ].filter(l => l !== null).join('\n');

    let replyStatus = 'success';
    let replyError = null;

    try {
        const waResult = await whatsappService.sendTextMessage(
            waba._id,
            phoneNumberId,
            addressOf(chat),
            lines,
            message.messageId  // reply to the original message
        );

        // Save the outbound auto-reply as a Message so it appears in the chat
        const msgId = waResult?.messages?.[0]?.id;
        const outboundMsg = await Message.create({
            chatId: chat._id,
            wabaId: waba._id,
            phoneNumberId,
            messageId: msgId,
            waId: chat.waId,
            bsuid: chat.bsuid,
            direction: 'outbound',
            type: 'text',
            text: lines,
            status: 'sent',
            sentByBot: true,
            metadata: {
                autoReplyType: 'product_lookup',
                matchedCode: code,
                source,
            },
            replyToMessageId: message._id,
        });

        // Update chat last message timestamp
        await Chat.findByIdAndUpdate(chat._id, { lastMessageAt: new Date(), lastStaffMessageAt: new Date() });

        // Emit socket event so frontend updates in real-time
        try {
            const io = getIO();
            io.emit('message:new', { chatId: chat._id, message: outboundMsg });
        } catch (e) {
            logger.warn('Socket emit failed for product auto-reply:', e.message);
        }

        logger.info(`Product code auto-reply sent for code "${code}" (${source}) to chat ${chat._id}`);
    } catch (err) {
        replyStatus = 'error';
        replyError = err.message;
        logger.error(`Failed to send product code auto-reply for "${code}": ${err.message}`);
    }

    // Log the attempt
    await ProductReplyLog.create({
        chatId: chat._id,
        messageId: message._id,
        productCode: code,
        productId: product._id,
        status: replyStatus,
        errorMessage: replyError,
        source,
    }).catch(e => logger.error('Failed to save ProductReplyLog:', e.message));
}

/**
 * Transcode an audio buffer (OGG/Opus) to AAC in an M4A container using ffmpeg.
 * Returns null (caller keeps the original buffer) if ffmpeg is missing or fails.
 */
async function transcodeAudioToM4a(inputBuffer) {
    const { spawn } = require('child_process');
    const fsp = require('fs').promises;
    const os = require('os');
    const path = require('path');
    const base = path.join(os.tmpdir(), `voice_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const inPath = `${base}.in`;
    const outPath = `${base}.m4a`;
    try {
        await fsp.writeFile(inPath, inputBuffer);
        await new Promise((resolve, reject) => {
            const ff = spawn('ffmpeg', ['-y', '-i', inPath, '-vn', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', outPath], { stdio: 'ignore' });
            const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, 20000);
            ff.on('error', (e) => { clearTimeout(timer); reject(e); });
            ff.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)); });
        });
        const out = await fsp.readFile(outPath);
        return out.length > 0 ? out : null;
    } catch (err) {
        logger.warn(`Voice note transcode skipped: ${err.message}`);
        return null;
    } finally {
        fsp.unlink(inPath).catch(() => {});
        fsp.unlink(outPath).catch(() => {});
    }
}

async function processMediaAsync(chat, messageData, type) {
    try {
        const { mediaId, wabaId, mimeType } = messageData;
        const waba = await Waba.findById(wabaId);
        if (!waba) return null;

        logger.info(`Downloading media ${mediaId} from WhatsApp...`);
        let buffer = await whatsappService.downloadMedia(waba._id, mediaId);

        // WhatsApp voice notes are OGG/Opus, which iOS Safari often cannot play.
        // Transcode to AAC (.m4a) when ffmpeg is available; otherwise keep the original.
        let storedMimeType = mimeType;
        if (type === 'audio' && /ogg|opus/i.test(mimeType || '')) {
            const converted = await transcodeAudioToM4a(buffer);
            if (converted) {
                buffer = converted;
                storedMimeType = 'audio/mp4';
            }
        }

        let uploadedUrl = null;
        let metadata = {};

        // Upload to VPS
        try {
            uploadedUrl = await uploadToVPS(buffer, {
                folder: 'inbound',
                publicId: mediaId,
                mimeType: storedMimeType,
                fileName: messageData.fileName,
            });
        } catch (uploadError) {
            logger.error(`VPS upload failed for ${mediaId}`, uploadError);
        }

        if (!uploadedUrl) {
            logger.error(`Failed to upload media ${mediaId} to VPS, dropping media`);
            return null;
        }

        const expiresAt = new Date();
        expiresAt.setFullYear(expiresAt.getFullYear() + 3);

        const mediaType = ['image', 'video', 'audio'].includes(type) ? type : 'document';

        // Save media metadata using the VPS URL
        const mediaDoc = await mediaService.saveMediaMetadata({
            mediaId: mediaId,
            url: uploadedUrl,
            type: mediaType,
            mimeType: storedMimeType,
            fileName: messageData.fileName,
            fileSize: buffer.length,
            expiresAt: expiresAt
        });

        if (type === 'image') {
            const ocrResult = await ocrService.extractTextFromImageBuffer(buffer);
            if (ocrResult.text) {
                metadata = {
                    ...metadata,
                    ocr: {
                        text: ocrResult.text,
                        confidence: ocrResult.confidence,
                        source: ocrResult.source || 'tesseract',
                    },
                };
                logger.info(`OCR (${ocrResult.source || 'tesseract'}) extracted ${ocrResult.text.length} chars for inbound media ${mediaId}`);
            }
        }

        logger.info(`Successfully processed and uploaded inbound media ${type} for message ${messageData.messageId}`);

        return {
            mediaUrl: uploadedUrl,
            metadata,
        };

    } catch (error) {
        logger.error('Error in processMediaAsync:', error);
        return null;
    }
}

async function processTemplateStatusWebhook(entry) {
    try {
        const changes = entry.changes[0];
        const value = changes.value;
        const wabaIdMeta = entry.id; // The Meta WABA ID

        const waba = await Waba.findOne({ wabaId: wabaIdMeta });
        if (!waba) {
            logger.warn(`WABA not found for ID: ${wabaIdMeta} during template status update`);
            return;
        }

        const templateName = value.message_template_name;
        const language = value.message_template_language;
        let eventStatus = value.event; // e.g., 'APPROVED', 'REJECTED', 'PENDING'

        // Sometimes the event might be different casing or format
        if (eventStatus) eventStatus = eventStatus.toUpperCase();

        const template = await require('../models/Template').findOneAndUpdate(
            { wabaId: waba._id, name: templateName, language: language },
            { $set: { status: eventStatus, templateId: value.message_template_id } },
            { new: true }
        );

        if (template) {
            logger.info(`Updated template ${templateName} status to ${eventStatus}`);
            // Optionally emit a socket event to update the frontend Template page
            try {
                const io = getIO();
                io.emit('template:status:update', template);
            } catch (emitError) {
                logger.warn('Socket emit failed for template status update:', emitError.message);
            }
        } else {
            logger.info(`Template ${templateName} (${language}) not found in DB to update status. Sync might be needed.`);
        }
    } catch (error) {
        logger.error('Error processing template status webhook:', error);
    }
}

module.exports = {
    processMediaAsync,
    retryFailedMessages,
    recordFailure,
    handleMessage,
    processWebhook,
    handleStatusUpdate,
    processTemplateStatusWebhook,
    detectProductCode,
    handleProductCodeReply,
};
