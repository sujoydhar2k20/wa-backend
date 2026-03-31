const { Chat, Message, ChatActivity } = require('../models');
const { getIO } = require('../websocket/socket.server');

async function list(req, res, next) {
    try {
        const {
            page = 1, limit = 20, wabaId, status, assignedTo, tag, isUnread, isWaiting
        } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = {};
        if (wabaId) filter.wabaId = wabaId;
        if (status) filter.status = status;
        if (tag) filter.tags = tag;
        if (isUnread !== undefined) filter.isUnread = isUnread === 'true';
        if (isWaiting === 'true') {
            filter.$or = [
                { lastStaffMessageAt: null },
                { $expr: { $gt: ['$lastCustomerMessageAt', '$lastStaffMessageAt'] } }
            ];
            // Usually waiting only applies to open chats
            if (!status) filter.status = { $ne: 'closed' };
        }

        // Staff can only see chats assigned to them (enforced server-side)
        if (req.user.role === 'staff') {
            filter.assignedTo = req.user._id;
        } else if (assignedTo) {
            filter.assignedTo = assignedTo === 'null' ? null : assignedTo;
        }

        const [chats, total] = await Promise.all([
            Chat.find(filter)
                .sort({ lastMessageAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('contactId', 'name nickname profilePicture isOptedOut isBlocked')
                .populate('assignedTo', 'name phone')
                .populate('wabaId', 'businessName phoneNumbers')
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

        const { Contact } = require('../models');
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

        // First find contacts whose name matches the query
        const matchingContacts = await Contact.find(
            { name: { $regex: q, $options: 'i' } },
            { _id: 1 }
        );
        const contactIds = matchingContacts.map(c => c._id);

        // Build a filter: match by phone number OR by linked contact name
        const baseFilter = {
            $or: [
                { phoneNumber: { $regex: q, $options: 'i' } },
                ...(contactIds.length > 0 ? [{ contactId: { $in: contactIds } }] : [])
            ]
        };
        if (wabaId) baseFilter.wabaId = wabaId;
        // Staff can only see their assigned chats
        if (req.user.role === 'staff') {
            baseFilter.assignedTo = req.user._id;
        }

        const [chats, total] = await Promise.all([
            Chat.find(baseFilter)
                .sort({ lastMessageAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('contactId', 'name nickname profilePicture')
                .populate('assignedTo', 'name phone')
                .populate('wabaId', 'businessName phoneNumbers')
                .populate('tags', 'name color'),
            Chat.countDocuments(baseFilter),
        ]);
        res.json({ data: chats, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

async function get(req, res, next) {
    try {
        const chat = await Chat.findById(req.params.id)
            .populate('contactId', 'name nickname profilePicture isOptedOut isBlocked customFields')
            .populate('assignedTo', 'name phone')
            .populate('wabaId', 'businessName phoneNumbers')
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
        const { staffId, userId } = req.body;
        const assigneeId = staffId || userId;
        const chat = await Chat.findById(req.params.id);
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        chat.assignedTo = assigneeId || null;
        await chat.save();

        await ChatActivity.create({
            chatId: chat._id,
            type: assigneeId ? 'assigned' : 'unassigned',
            performedBy: req.user._id,
            details: { assignedTo: assigneeId || undefined },
        });

        // Re-fetch with full population so the response matches GET /chats/:id
        const populated = await Chat.findById(chat._id)
            .populate('contactId', 'name nickname profilePicture isOptedOut isBlocked customFields')
            .populate('assignedTo', 'name phone')
            .populate('wabaId', 'businessName phoneNumbers')
            .populate('collaborators', 'name phone')
            .populate('tags', 'name color');

        // Save a persistent system message so it appears after page refresh
        const systemText = assigneeId
            ? `${req.user.name || 'Admin'} assigned this chat to ${populated.assignedTo?.name || 'someone'}`
            : `${req.user.name || 'Admin'} unassigned this chat`;

        const sysMessage = await Message.create({
            chatId: chat._id,
            wabaId: chat.wabaId,
            direction: 'internal',
            type: 'system',
            text: systemText,
            sentBy: req.user._id,
        });
        const populatedSysMsg = await sysMessage.populate('sentBy', 'name phone');

        // Broadcast real-time update to all connected clients
        const io = getIO();
        const payload = { chatId: chat._id.toString(), chat: populated, systemMessage: populatedSysMsg };
        io.emit('chat:assigned', payload);   // everyone updates their chat list
        io.emit('chat:update', payload);     // also triggers chats list refresh

        // Notify the specific assigned staff member's personal room
        if (assigneeId) {
            io.to(`user:${assigneeId}`).emit('chat:assigned:me', {
                chatId: chat._id.toString(),
                chat: populated,
                assignedByName: req.user.name || 'Admin',
            });
        }

        res.json(populated);
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
        const chat = await Chat.findById(req.params.id);
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        const now = new Date();
        chat.status = 'closed';
        chat.closedAt = now;
        await chat.save();

        await ChatActivity.create({
            chatId: chat._id,
            type: 'closed',
            performedBy: req.user._id,
            details: {},
        });

        const sysMessage = await Message.create({
            chatId: chat._id,
            wabaId: chat.wabaId,
            direction: 'internal',
            type: 'system',
            text: `${req.user.name || 'Admin'} closed this chat`,
            sentBy: req.user._id,
        });
        const populatedSysMsg = await sysMessage.populate('sentBy', 'name phone');

        // Re-fetch with full population so the frontend keeps contact info, assignment, and tags
        const populated = await Chat.findById(chat._id)
            .populate('contactId', 'name nickname profilePicture isOptedOut isBlocked customFields')
            .populate('assignedTo', 'name phone')
            .populate('wabaId', 'businessName phoneNumbers')
            .populate('collaborators', 'name phone')
            .populate('tags', 'name color');

        const io = getIO();
        io.emit('message:new', {
            chatId: chat._id.toString(),
            message: populatedSysMsg
        });
        io.emit('chat:update', { chatId: chat._id.toString(), chat: populated });

        res.json(populated);
    } catch (e) {
        next(e);
    }
}

async function reopen(req, res, next) {
    try {
        const chat = await Chat.findById(req.params.id);
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

        // Only allow reopen if the WhatsApp 24-hour session window is still active.
        // Superadmins can bypass this restriction.
        const isSuperAdmin = req.user.role === 'superadmin';
        const sessionActive = chat.sessionExpiresAt && new Date(chat.sessionExpiresAt) > new Date();
        if (!isSuperAdmin && !sessionActive) {
            return res.status(400).json({
                success: false,
                message: 'Cannot reopen: the WhatsApp 24-hour session window has expired. Wait for the customer to message again.',
            });
        }

        chat.status = 'open';
        chat.closedAt = undefined;
        await chat.save();

        await ChatActivity.create({
            chatId: chat._id,
            type: 'reopened',
            performedBy: req.user._id,
            details: {},
        });

        const sysMessage = await Message.create({
            chatId: chat._id,
            wabaId: chat.wabaId,
            direction: 'internal',
            type: 'system',
            text: `${req.user.name || 'Admin'} reopened this chat`,
            sentBy: req.user._id,
        });
        const populatedSysMsg = await sysMessage.populate('sentBy', 'name phone');

        // Re-fetch with full population so the frontend keeps contact info, assignment, and tags
        const populated = await Chat.findById(chat._id)
            .populate('contactId', 'name nickname profilePicture isOptedOut isBlocked customFields')
            .populate('assignedTo', 'name phone')
            .populate('wabaId', 'businessName phoneNumbers')
            .populate('collaborators', 'name phone')
            .populate('tags', 'name color');

        const io = getIO();
        io.emit('message:new', {
            chatId: chat._id.toString(),
            message: populatedSysMsg
        });
        io.emit('chat:update', { chatId: chat._id.toString(), chat: populated });

        res.json(populated);
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

async function stats(req, res, next) {
    try {
        const { wabaId, assignedTo } = req.query;
        const filter = {};
        if (wabaId) filter.wabaId = wabaId;

        // Apply staff restriction or explicit filter
        if (req.user.role === 'staff') {
            filter.assignedTo = req.user._id;
        } else if (assignedTo) {
            filter.assignedTo = assignedTo === 'null' ? null : assignedTo;
        }

        const results = await Promise.all([
            Chat.countDocuments(filter),
            Chat.countDocuments({ ...filter, status: 'open' }),
            Chat.countDocuments({ ...filter, isUnread: true }),
            Chat.countDocuments({ ...filter, status: 'closed' }),
            Chat.countDocuments({
                ...filter,
                $or: [
                    { lastStaffMessageAt: null },
                    { $expr: { $gt: ['$lastCustomerMessageAt', '$lastStaffMessageAt'] } }
                ],
                status: { $ne: 'closed' }
            })
        ]);

        res.json({
            all: results[0],
            open: results[1],
            unread: results[2],
            closed: results[3],
            waiting: results[4]
        });
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
    stats,
};
