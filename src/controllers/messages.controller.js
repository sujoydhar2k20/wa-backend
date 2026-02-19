const { Message, Chat } = require('../models');
const whatsappService = require('../services/whatsapp.service');

async function send(req, res, next) {
    try {
        const { chatId, type = 'text', text, mediaUrl, caption, templateName, language, components } = req.body;
        if (!chatId) return res.status(400).json({ success: false, message: 'chatId is required' });

        const chat = await Chat.findById(chatId);
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        let waResult;
        if (type === 'text') {
            if (!text) return res.status(400).json({ success: false, message: 'text is required for text messages' });
            waResult = await whatsappService.sendTextMessage(chat.wabaId, chat.phoneNumberId, chat.waId, text);
        } else if (type === 'template') {
            if (!templateName) return res.status(400).json({ success: false, message: 'templateName is required for template messages' });
            waResult = await whatsappService.sendTemplateMessage(chat.wabaId, chat.phoneNumberId, chat.waId, templateName, language || 'en', components || []);
        } else if (['image', 'video', 'audio', 'document'].includes(type)) {
            if (!mediaUrl) return res.status(400).json({ success: false, message: 'mediaUrl is required for media messages' });
            waResult = await whatsappService.sendMediaMessage(chat.wabaId, chat.phoneNumberId, chat.waId, type, mediaUrl, caption || '');
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
            text: type === 'text' ? text : undefined,
            mediaUrl: mediaUrl || undefined,
            caption: caption || undefined,
            status: 'sent',
            sentBy: req.user._id,
        });

        // Update chat last message timestamp
        await Chat.findByIdAndUpdate(chatId, { lastMessageAt: new Date(), lastStaffMessageAt: new Date() });

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
        if (!emoji) return res.status(400).json({ success: false, message: 'emoji is required' });

        const message = await Message.findById(req.params.id);
        if (!message) return res.status(404).json({ success: false, message: 'Message not found' });

        const chat = await Chat.findById(message.chatId);
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        await whatsappService.reactToMessage(chat.wabaId, message.messageId, emoji);
        res.json({ success: true });
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

module.exports = { send, search, react, markRead };
