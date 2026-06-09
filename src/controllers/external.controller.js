const { Chat, Message, Contact, ApiKey } = require('../models');
const crypto = require('crypto');
const { getIO } = require('../websocket/socket.server');
const { logger } = require('../utils/logger');
const whatsappService = require('../services/whatsapp.service');

const sendTemplate = async (req, res) => {
    try {
        const { to, templateName, language = 'en_US', components = [] } = req.body;
        const { waba, phoneNumberId, name: keyName } = req.external;

        if (!to || !templateName) {
            return res.status(400).json({ error: 'Missing required fields: to, templateName' });
        }

        // Clean phone number (remove +, spaces, etc.)
        const waId = to.replace(/\D/g, '');

        // Find or create contact
        let contact = await Contact.findOne({ waId });
        if (!contact) {
            contact = await Contact.create({
                phoneNumber: waId,
                waId,
                name: `External Contact (${waId})`,
                nameOnWhatsApp: waId
            });
        }

        // Find or create chat
        let chat = await Chat.findOne({ wabaId: waba._id, waId });
        if (!chat) {
            chat = await Chat.create({
                wabaId: waba._id,
                phoneNumberId,
                phoneNumber: waId,
                waId,
                contactId: contact._id,
                status: 'open',
                lastMessageAt: new Date(),
                lastCustomerMessageAt: new Date(0), // No customer message yet
                isUnread: false
            });
        }

        // Block sending to blocked or opted-out contacts
        if (contact.isBlocked || contact.isOptedOut) {
            return res.status(403).json({
                error: 'Cannot send messages to blocked or opted-out contacts.'
            });
        }

        // Send template via WhatsApp Service
        const waResult = await whatsappService.sendTemplateMessage(
            waba._id,
            phoneNumberId,
            waId,
            templateName,
            language,
            components
        );

        const messageId = waResult?.messages?.[0]?.id;

        // Look up template from DB for rich preview in chat
        const Template = require('../models/Template');
        const templateDoc = await Template.findOne({ wabaId: waba._id, name: templateName, language: language || 'en' });
        let resolvedComponents = null;
        let messageText = `[Template: ${templateName}]`;
        if (templateDoc) {
            resolvedComponents = (templateDoc.components || []).map(comp => {
                const c = comp.toObject ? comp.toObject() : { ...comp };
                if (c.text && (c.type === 'BODY' || c.type === 'HEADER')) {
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
            const bodyComp = resolvedComponents.find(c => c.type === 'BODY');
            if (bodyComp?.text) messageText = bodyComp.text;
        }

        // Record the outbound message
        const message = await Message.create({
            chatId: chat._id,
            wabaId: waba._id,
            phoneNumberId,
            messageId,
            waId,
            direction: 'outbound',
            type: 'template',
            text: messageText,
            status: 'sent',
            metadata: {
                externalSource: keyName,
                templateName,
                templateLanguage: language,
                templateComponents: resolvedComponents || undefined,
                language,
                components
            }
        });

        // Update chat metadata
        chat.lastMessageAt = new Date();
        chat.lastStaffMessageAt = new Date();
        await chat.save();

        // Emit socket event for real-time UI update
        try {
            const io = getIO();
            io.emit('message:new', { chatId: chat._id, message });
            
            // Also update chat list
            const populatedChat = await Chat.findById(chat._id).populate('contactId');
            io.emit('chat:update', { chatId: chat._id, chat: populatedChat });
        } catch (e) {
            logger.warn('Socket emit failed for external template message:', e.message);
        }

        return res.status(200).json({
            success: true,
            messageId,
            chatId: chat._id,
            status: 'sent'
        });

    } catch (error) {
        logger.error('External API sendTemplate Error:', error);
        return res.status(error.response?.status || 500).json({
            error: error.message || 'Internal server error',
            details: error.response?.data || null
        });
    }
};

const listKeys = async (req, res) => {
    try {
        const keys = await ApiKey.find({ createdBy: req.user._id }).populate('wabaId', 'businessName').sort('-createdAt');
        res.json(keys);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const createKey = async (req, res) => {
    try {
        const { name, wabaId, phoneNumberId } = req.body;
        if (!name || !wabaId || !phoneNumberId) {
            return res.status(400).json({ error: 'Missing name, wabaId, or phoneNumberId' });
        }

        // Generate a random secure key
        const key = `ak_${crypto.randomBytes(24).toString('hex')}`;

        const apiKey = await ApiKey.create({
            name,
            key,
            wabaId,
            phoneNumberId,
            createdBy: req.user._id
        });

        res.status(201).json(apiKey);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const toggleKey = async (req, res) => {
    try {
        const { id } = req.params;
        const { isActive } = req.body;
        const key = await ApiKey.findOneAndUpdate(
            { _id: id, createdBy: req.user._id },
            { isActive },
            { new: true }
        );
        if (!key) return res.status(404).json({ error: 'Key not found' });
        res.json(key);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const deleteKey = async (req, res) => {
    try {
        const { id } = req.params;
        const key = await ApiKey.findOneAndDelete({ _id: id, createdBy: req.user._id });
        if (!key) return res.status(404).json({ error: 'Key not found' });
        res.json({ message: 'Key deleted' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    sendTemplate,
    listKeys,
    createKey,
    toggleKey,
    deleteKey
};
