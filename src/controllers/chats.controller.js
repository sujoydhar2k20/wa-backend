const { Chat, Message, ChatActivity } = require('../models');

async function list(req, res, next) {
    try {
        const {
            page = 1, limit = 20, wabaId, status, assignedTo, tag, isUnread,
        } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = {};
        if (wabaId) filter.wabaId = wabaId;
        if (status) filter.status = status;
        if (assignedTo) filter.assignedTo = assignedTo;
        if (tag) filter.tags = tag;
        if (isUnread !== undefined) filter.isUnread = isUnread === 'true';

        const [chats, total] = await Promise.all([
            Chat.find(filter)
                .sort({ lastMessageAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('contactId', 'name profilePicture isOptedOut isBlocked')
                .populate('assignedTo', 'name phone')
                .populate('tags', 'name color'),
            Chat.countDocuments(filter),
        ]);
        res.json({ data: chats, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

async function search(req, res, next) {
    try {
        const { q, page = 1, limit = 20, wabaId } = req.query;
        if (!q) return res.status(400).json({ success: false, message: 'Query param q is required' });
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = { phoneNumber: { $regex: q, $options: 'i' } };
        if (wabaId) filter.wabaId = wabaId;
        const [chats, total] = await Promise.all([
            Chat.find(filter)
                .sort({ lastMessageAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('contactId', 'name profilePicture')
                .populate('assignedTo', 'name phone')
                .populate('tags', 'name color'),
            Chat.countDocuments(filter),
        ]);
        res.json({ data: chats, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

async function get(req, res, next) {
    try {
        const chat = await Chat.findById(req.params.id)
            .populate('contactId', 'name profilePicture isOptedOut isBlocked customFields')
            .populate('assignedTo', 'name phone')
            .populate('collaborators', 'name phone')
            .populate('tags', 'name color');
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
        res.json(chat);
    } catch (e) {
        next(e);
    }
}

async function assign(req, res, next) {
    try {
        const { userId } = req.body;
        const chat = await Chat.findById(req.params.id);
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        chat.assignedTo = userId || null;
        await chat.save();

        await ChatActivity.create({
            chatId: chat._id,
            type: userId ? 'assigned' : 'unassigned',
            performedBy: req.user._id,
            details: { assignedTo: userId || undefined },
        });

        res.json(chat);
    } catch (e) {
        next(e);
    }
}

async function transfer(req, res, next) {
    try {
        const { toUserId } = req.body;
        if (!toUserId) return res.status(400).json({ success: false, message: 'toUserId is required' });

        const chat = await Chat.findById(req.params.id);
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        const fromUserId = chat.assignedTo;
        chat.assignedTo = toUserId;
        await chat.save();

        await ChatActivity.create({
            chatId: chat._id,
            type: 'transferred',
            performedBy: req.user._id,
            details: { transferredFrom: fromUserId, transferredTo: toUserId },
        });

        res.json(chat);
    } catch (e) {
        next(e);
    }
}

async function close(req, res, next) {
    try {
        const chat = await Chat.findByIdAndUpdate(
            req.params.id,
            { status: 'closed' },
            { new: true }
        );
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        await ChatActivity.create({
            chatId: chat._id,
            type: 'closed',
            performedBy: req.user._id,
            details: {},
        });

        res.json(chat);
    } catch (e) {
        next(e);
    }
}

async function reopen(req, res, next) {
    try {
        const chat = await Chat.findByIdAndUpdate(
            req.params.id,
            { status: 'open' },
            { new: true }
        );
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        await ChatActivity.create({
            chatId: chat._id,
            type: 'reopened',
            performedBy: req.user._id,
            details: {},
        });

        res.json(chat);
    } catch (e) {
        next(e);
    }
}

async function markRead(req, res, next) {
    try {
        const chat = await Chat.findByIdAndUpdate(
            req.params.id,
            { isUnread: false },
            { new: true }
        );
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
        res.json({ success: true });
    } catch (e) {
        next(e);
    }
}

async function markUnread(req, res, next) {
    try {
        const chat = await Chat.findByIdAndUpdate(
            req.params.id,
            { isUnread: true },
            { new: true }
        );
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
        res.json({ success: true });
    } catch (e) {
        next(e);
    }
}

async function getMessages(req, res, next) {
    try {
        const { page = 1, limit = 50 } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = { chatId: req.params.id };
        const [messages, total] = await Promise.all([
            Message.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('sentBy', 'name phone'),
            Message.countDocuments(filter),
        ]);
        res.json({ data: messages.reverse(), total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

async function getActivities(req, res, next) {
    try {
        const { page = 1, limit = 30 } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = { chatId: req.params.id };
        const [activities, total] = await Promise.all([
            ChatActivity.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('performedBy', 'name phone'),
            ChatActivity.countDocuments(filter),
        ]);
        res.json({ data: activities, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

module.exports = {
    list,
    search,
    get,
    assign,
    transfer,
    close,
    reopen,
    markRead,
    markUnread,
    getMessages,
    getActivities,
};
