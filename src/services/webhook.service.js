const { Waba, Chat, Message, User, Contact } = require('../models');
const { getIO } = require('../websocket/socket.server');
const { logger } = require('../utils/logger');
const whatsappService = require('./whatsapp.service');
const mediaService = require('./media.service');
const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');

async function processWebhook(entry) {
    try {
        const changes = entry.changes[0];
        const value = changes.value;

        // Check if it's a message or a status update
        if (value.statuses && value.statuses.length > 0) {
            for (const statusObj of value.statuses) {
                await handleStatusUpdate(statusObj);
            }
        }

        if (!value.messages || !value.messages.length) return;
        const metadata = value.metadata;
        const wabaIdMeta = entry.id; // The Meta WABA ID
        const phoneNumberId = metadata.phone_number_id;

        // Find our WABA in DB
        const waba = await Waba.findOne({ wabaId: wabaIdMeta });
        if (!waba) {
            logger.error(`WABA not found for ID: ${wabaIdMeta}`);
            return;
        }

        const contacts = value.contacts || [];
        const messages = value.messages;

        for (const msg of messages) {
            await handleMessage(waba, phoneNumberId, msg, contacts);
        }
    } catch (error) {
        logger.error('Error processing webhook:', error);
    }
}

async function handleMessage(waba, phoneNumberId, msg, contacts) {
    const waId = msg.from; // Sender's phone number
    const contactData = contacts.find(c => c.wa_id === waId);
    const profileName = contactData?.profile?.name || waId;

    // Contact handling
    let contact = await Contact.findOne({ waId });
    if (!contact) {
        contact = await Contact.create({
            phoneNumber: waId,
            waId,
            nameOnWhatsApp: profileName,
            name: profileName !== waId ? profileName : '',
        });
    } else {
        let updated = false;
        if (profileName !== waId && contact.nameOnWhatsApp !== profileName) {
            contact.nameOnWhatsApp = profileName;
            updated = true;
        }
        if (profileName !== waId && !contact.name) {
            contact.name = profileName;
            updated = true;
        }
        if (updated) {
            await contact.save();
        }
    }

    // Find or create chat
    let chat = await Chat.findOne({ wabaId: waba._id, waId });
    const isNewChat = !chat;

    if (!chat) {
        chat = new Chat({
            wabaId: waba._id,
            phoneNumberId,
            phoneNumber: waId,
            waId,
            contactId: contact._id,
            status: 'open',
            isUnread: true,
            lastCustomerMessageAt: new Date(),
        });
    } else if (!chat.contactId) {
        chat.contactId = contact._id;
    }

    // Auto-assign new chat to the least-loaded active staff member on this WABA (round-robin by open chat count)
    if (isNewChat && !chat.assignedTo) {
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
                    `Auto-assigned new chat (waId: ${waId}) to staff ${leastLoaded.staffId} (open chats: ${leastLoaded.count})`
                );
            }
        } catch (err) {
            logger.error('Error auto-assigning staff to chat:', err);
        }
    }

    // Update chat metadata
    chat.lastMessageAt = new Date();
    chat.lastCustomerMessageAt = new Date();
    chat.isUnread = true;

    // Set WhatsApp Session Expiry exactly 24 hours from the incoming message timestamp
    chat.sessionExpiresAt = new Date((msg.timestamp * 1000) + (24 * 60 * 60 * 1000));

    if (chat.status === 'closed') chat.status = 'open';

    await chat.save();

    // Create message
    const messageData = {
        chatId: chat._id,
        wabaId: waba._id,
        phoneNumberId,
        messageId: msg.id,
        waId,
        direction: 'inbound',
        type: msg.type,
        status: 'delivered',
        timestamp: new Date(msg.timestamp * 1000),
    };

    // Handle message types
    if (msg.type === 'text') {
        messageData.text = msg.text.body;
    } else if (msg.type === 'reaction') {
        const targetMessageId = msg.reaction.message_id;
        const emoji = msg.reaction.emoji;

        const targetMsg = await Message.findOne({ messageId: targetMessageId });
        if (targetMsg) {
            targetMsg.reactions = targetMsg.reactions.filter(r => r.by !== waId);
            if (emoji) {
                targetMsg.reactions.push({ emoji, by: waId });
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
    } else if (['image', 'video', 'audio', 'document'].includes(msg.type)) {
        const mediaField = msg[msg.type];
        messageData.mediaId = mediaField.id;
        messageData.mimeType = mediaField.mime_type;
        messageData.caption = mediaField.caption || null;
        if (msg.type === 'document') {
            messageData.fileName = mediaField.filename;
        }

        // Process media download/upload synchronously before saving the message
        try {
            const finalUrl = await processMediaAsync(chat, messageData, msg.type);
            if (finalUrl) {
                messageData.mediaUrl = finalUrl;
            }
        } catch (err) {
            logger.error(`Failed to process media ${msg.type} for message ${msg.id}:`, err);
        }
    }
    // Add other types as needed

    const message = await Message.create(messageData);

    // Send push notification
    try {
        const pushService = require('./push.service');
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
            await pushService.sendPushNotificationToUsers(userIdsToNotify, {
                title: profileName ? `New message from ${profileName}` : `New message from ${waId}`,
                body: messageData.text || (messageData.mediaId ? `Received a ${msg.type}` : 'Received a new message'),
                url: `/dashboard/chats/${chat._id}`
            });
        }
    } catch (pushErr) {
        logger.error(`Error triggering push notification: ${pushErr.message}`);
    }

    // Emit socket event
    try {
        const io = getIO();
        io.emit('message:new', {
            chatId: chat._id,
            message
        });

        await chat.populate('contactId', 'name nameOnWhatsApp profilePicture');

        // Also notify about chat update (unread count, last msg)
        io.emit('chat:update', {
            chatId: chat._id,
            chat: {
                ...chat.toObject(),
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

        const message = await Message.findOneAndUpdate(
            { messageId },
            {
                $set: {
                    status: status,
                    statusTimestamp: timestamp
                }
            },
            { new: true }
        );

        if (message) {
            logger.info(`Successfully updated message ${message._id} to ${status}`);
            // Emit socket event for frontend to update checkmarks
            const io = getIO();
            io.emit('message:status', {
                chatId: message.chatId,
                messageId: message._id, // Mongo ID used by frontend
                waMessageId: messageId, // Meta ID
                status: status
            });
        } else {
            logger.warn(`No message found in DB for Meta ID: ${messageId}`);
        }
    } catch (e) {
        logger.error('Error handling status update:', e.message);
    }
}

async function processMediaAsync(chat, messageData, type) {
    try {
        const { mediaId, wabaId, mimeType } = messageData;
        const waba = await Waba.findById(wabaId);
        if (!waba) return null;

        logger.info(`Downloading media ${mediaId} from WhatsApp...`);
        const buffer = await whatsappService.downloadMedia(waba._id, mediaId);

        let uploadedUrl = null;

        // Save to Cloudinary
        const resourceType = ['video', 'audio'].includes(type) ? 'video' : 'auto';
        const uploadOptions = {
            folder: 'whatsapp-bot/inbound',
            resource_type: resourceType,
            public_id: mediaId
        };

        // Force mp4 for audio compatibility
        if (type === 'audio') {
            uploadOptions.format = 'mp4';
        }

        cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET
        });

        try {
            uploadedUrl = await new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream(
                    uploadOptions,
                    (error, result) => {
                        if (error) return reject(new Error(error.message));
                        resolve(result.secure_url);
                    }
                );
                streamifier.createReadStream(buffer).pipe(uploadStream);
            });
        } catch (uploadError) {
            logger.error(`Cloudinary upload failed for ${mediaId}`, uploadError);
        }

        if (!uploadedUrl) {
            logger.error(`Failed to get Cloudinary URL for media ${mediaId}, dropping media`);
            return null;
        }

        const expiresAt = new Date();
        expiresAt.setFullYear(expiresAt.getFullYear() + 3);

        const mediaType = ['image', 'video', 'audio'].includes(type) ? type : 'document';

        // Save media metadata using the Cloudinary URL
        const mediaDoc = await mediaService.saveMediaMetadata({
            mediaId: mediaId,
            url: uploadedUrl,
            type: mediaType,
            mimeType: mimeType,
            fileName: messageData.fileName,
            fileSize: buffer.length,
            expiresAt: expiresAt
        });

        const finalUrl = uploadedUrl;
        logger.info(`Successfully processed and uploaded inbound media ${type} for message ${messageData.messageId}`);

        return finalUrl;

    } catch (error) {
        logger.error('Error in processMediaAsync:', error);
        return null;
    }
}

module.exports = {
    processWebhook,
    handleStatusUpdate
};
