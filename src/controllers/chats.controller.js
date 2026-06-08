const { Chat, Message, ChatActivity, ProductReplyLog, BotExecution, BotFlow } = require('../models');
const { getIO } = require('../websocket/socket.server');

async function list(req, res, next) {
    try {
        const {
            page = 1, limit = 20, wabaId, status, assignedTo, tag, tags, tagId, isUnread, isWaiting
        } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = {};
        if (wabaId) filter.wabaId = wabaId;
        if (status) filter.status = status;
        const filterTag = tag || tags || tagId;
        if (filterTag) filter.tags = filterTag;
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
        const parsedLimit = parseInt(limit, 10);
        const skip = (parseInt(page, 10) - 1) * parsedLimit;

        // Build access filter for staff restriction & wabaId
        const accessFilter = {};
        if (wabaId) accessFilter.wabaId = wabaId;
        if (req.user.role === 'staff') {
            accessFilter.assignedTo = req.user._id;
        }

        // 1. Find contacts matching by name or nickname
        const matchingContacts = await Contact.find(
            { $or: [
                { name: { $regex: q, $options: 'i' } },
                { nickname: { $regex: q, $options: 'i' } }
            ]},
            { _id: 1, name: 1, nickname: 1 }
        );
        const contactMap = {};
        matchingContacts.forEach(c => { contactMap[c._id.toString()] = c; });
        const contactIds = matchingContacts.map(c => c._id);

        // 2. Find chats matching by phone number or contact name/nickname
        const namePhoneFilter = {
            ...accessFilter,
            $or: [
                { phoneNumber: { $regex: q, $options: 'i' } },
                ...(contactIds.length > 0 ? [{ contactId: { $in: contactIds } }] : [])
            ]
        };

        const namePhoneChats = await Chat.find(namePhoneFilter)
            .sort({ lastMessageAt: -1 })
            .limit(parsedLimit)
            .populate('contactId', 'name nickname profilePicture')
            .populate('assignedTo', 'name phone')
            .populate('wabaId', 'businessName phoneNumbers')
            .populate('tags', 'name color')
            .lean();

        // Tag each result with what matched
        const seenChatIds = new Set();
        const results = [];
        for (const chat of namePhoneChats) {
            const cid = chat._id.toString();
            seenChatIds.add(cid);
            let matchSource = 'phone';
            if (chat.contactId) {
                const n = chat.contactId.nickname || '';
                const nm = chat.contactId.name || '';
                if (n && n.match(new RegExp(q, 'i'))) matchSource = 'nickname';
                else if (nm && nm.match(new RegExp(q, 'i'))) matchSource = 'name';
            }
            results.push({ ...chat, matchSource });
        }

        // 3. Search messages for text content matches
        const remaining = parsedLimit - results.length;
        if (remaining > 0) {
            // Find messages whose text matches the query
            const msgFilter = { text: { $regex: q, $options: 'i' }, type: { $ne: 'system' } };
            const matchingMessages = await Message.aggregate([
                { $match: msgFilter },
                { $sort: { createdAt: -1 } },
                { $group: {
                    _id: '$chatId',
                    matchedText: { $first: '$text' },
                    matchedAt: { $first: '$createdAt' },
                    matchedMessageId: { $first: '$_id' }
                }},
                { $limit: remaining + seenChatIds.size } // fetch extra to account for duplicates
            ]);

            // Filter out chats already found by name/phone
            const msgChatIds = matchingMessages
                .filter(m => !seenChatIds.has(m._id.toString()))
                .slice(0, remaining);

            if (msgChatIds.length > 0) {
                const msgChatFilter = {
                    ...accessFilter,
                    _id: { $in: msgChatIds.map(m => m._id) }
                };
                const msgChats = await Chat.find(msgChatFilter)
                    .populate('contactId', 'name nickname profilePicture')
                    .populate('assignedTo', 'name phone')
                    .populate('wabaId', 'businessName phoneNumbers')
                    .populate('tags', 'name color')
                    .lean();

                // Build a lookup for matched messages
                const msgLookup = {};
                msgChatIds.forEach(m => {
                    msgLookup[m._id.toString()] = {
                        text: m.matchedText,
                        messageId: m.matchedMessageId
                    };
                });

                for (const chat of msgChats) {
                    const lookup = msgLookup[chat._id.toString()] || {};
                    results.push({
                        ...chat,
                        matchSource: 'message',
                        matchedMessage: lookup.text || '',
                        matchedMessageId: lookup.messageId || null
                    });
                }
            }
        }

        // Sort combined results by lastMessageAt descending
        results.sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));

        res.json({ data: results, total: results.length, page: parseInt(page, 10), limit: parsedLimit });
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
            { isUnread: false, isManuallyUnread: false },
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
            { isUnread: true, isManuallyUnread: true },
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
        const { page = 1, limit = 50, messageId } = req.query;
        const filter = { chatId: req.params.id };

        let finalLimit = parseInt(limit, 10);
        let finalSkip = (parseInt(page, 10) - 1) * finalLimit;

        if (messageId) {
            const targetMsg = await Message.findById(messageId);
            if (targetMsg) {
                const newerCount = await Message.countDocuments({
                    chatId: req.params.id,
                    createdAt: { $gt: targetMsg.createdAt }
                });
                finalLimit = Math.max(finalLimit, newerCount + 50);
                finalSkip = 0;
            }
        }

        const [messages, total] = await Promise.all([
            Message.find(filter)
                .sort({ createdAt: -1 })
                .skip(finalSkip)
                .limit(finalLimit)
                .populate('sentBy', 'name phone'),
            Message.countDocuments(filter),
        ]);
        res.json({ data: messages.reverse(), total, page: parseInt(page, 10), limit: finalLimit });
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
        const { wabaId, assignedTo, tag, tags, tagId } = req.query;
        const filter = {};
        if (wabaId) filter.wabaId = wabaId;
        const filterTag = tag || tags || tagId;
        if (filterTag) filter.tags = filterTag;

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

async function toggleDnd(req, res, next) {
    try {
        const { isDnd } = req.body;
        const chat = await Chat.findByIdAndUpdate(
            req.params.id,
            { isDnd: !!isDnd },
            { new: true }
        );
        if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
        res.json(chat);
    } catch (e) {
        next(e);
    }
}

async function getAutoMessages(req, res, next) {
    try {
        const chatId = req.params.id;
        const { page = 1, limit = 50 } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

        // 1. Fetch all bot-sent messages for this chat
        const [autoMessages, total] = await Promise.all([
            Message.find({ chatId, sentByBot: true })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .lean(),
            Message.countDocuments({ chatId, sentByBot: true }),
        ]);

        // 2. Fetch ProductReplyLogs for this chat to enrich product code replies
        const productLogs = await ProductReplyLog.find({ chatId })
            .populate('productId', 'code name category weight')
            .lean();

        // Build lookup: messageId (ObjectId) -> productLog
        const productLogByMsgId = {};
        for (const log of productLogs) {
            if (log.messageId) {
                productLogByMsgId[log.messageId.toString()] = log;
            }
        }

        // 3. Fetch BotExecution logs for this chat to identify which flow triggered which message
        const botExecutions = await BotExecution.find({ chatId })
            .populate('flowId', 'name')
            .sort({ startedAt: -1 })
            .lean();

        // 4. Enrich each auto message with source context
        const enriched = autoMessages.map(msg => {
            const result = {
                _id: msg._id,
                messageId: msg.messageId,
                type: msg.type,
                text: msg.text,
                mediaUrl: msg.mediaUrl,
                caption: msg.caption,
                status: msg.status,
                createdAt: msg.createdAt,
                direction: msg.direction,
                metadata: msg.metadata,
                // Determine source/medium
                source: 'bot',
                sourceLabel: 'Bot Flow',
                sourceIcon: 'bot',
                productCode: null,
                productInfo: null,
                flowName: null,
            };

            // Check if this is a product code auto-reply
            if (msg.metadata?.autoReplyType === 'product_lookup') {
                const source = msg.metadata?.source;
                if (source === 'image_ocr') {
                    result.source = 'image_ocr';
                    result.sourceLabel = 'Image Code Detection';
                    result.sourceIcon = 'image';
                } else {
                    result.source = 'text_code';
                    result.sourceLabel = 'Chat Code Detection';
                    result.sourceIcon = 'text';
                }
                result.productCode = msg.metadata?.matchedCode || null;

                // Enrich with product log data
                const pLog = productLogByMsgId[msg.replyToMessageId?.toString()];
                if (pLog?.productId) {
                    result.productInfo = pLog.productId;
                }
            } else {
                // This is a bot flow message - find which flow triggered it
                const msgTime = new Date(msg.createdAt).getTime();
                const matchingExec = botExecutions.find(exec => {
                    const startTime = new Date(exec.startedAt).getTime();
                    const endTime = exec.completedAt ? new Date(exec.completedAt).getTime() : startTime + 60000;
                    return msgTime >= startTime && msgTime <= endTime + 5000;
                });
                if (matchingExec?.flowId) {
                    result.flowName = matchingExec.flowId.name || 'Unknown Flow';
                }
            }

            return result;
        });

        res.json({ data: enriched, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
    }
}

async function getAllAutoMessages(req, res, next) {
    try {
        const { page = 1, limit = 50 } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

        // 1. Fetch all bot-sent messages system-wide
        const [autoMessages, total] = await Promise.all([
            Message.find({ sentByBot: true })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate({
                    path: 'chatId',
                    select: 'phoneNumber',
                    populate: {
                       path: 'contactId',
                       select: 'name phone'
                    }
                })
                .lean(),
            Message.countDocuments({ sentByBot: true }),
        ]);

        // 2. Fetch all related ProductReplyLogs to enrich product code replies
        const chatIds = [...new Set(autoMessages.map(m => m.chatId?._id?.toString()).filter(Boolean))];
        const productLogs = await ProductReplyLog.find({ chatId: { $in: chatIds } })
            .populate('productId', 'code name category weight')
            .lean();

        // Build lookup: messageId (ObjectId) -> productLog
        const productLogByMsgId = {};
        for (const log of productLogs) {
            if (log.messageId) {
                productLogByMsgId[log.messageId.toString()] = log;
            }
        }

        // 3. Fetch BotExecution logs for these chats
        const botExecutions = await BotExecution.find({ chatId: { $in: chatIds } })
            .populate('flowId', 'name')
            .sort({ startedAt: -1 })
            .lean();

        // 4. Enrich each auto message with source context
        const enriched = autoMessages.map(msg => {
            const result = {
                _id: msg._id,
                messageId: msg.messageId,
                chat: msg.chatId, // Includes populated chat data (contact, phone)
                type: msg.type,
                text: msg.text,
                mediaUrl: msg.mediaUrl,
                caption: msg.caption,
                status: msg.status,
                createdAt: msg.createdAt,
                direction: msg.direction,
                metadata: msg.metadata,
                source: 'bot',
                sourceLabel: 'Bot Flow',
                sourceIcon: 'bot',
                productCode: null,
                productInfo: null,
                flowName: null,
            };

            if (msg.metadata?.autoReplyType === 'product_lookup') {
                const source = msg.metadata?.source;
                if (source === 'image_ocr') {
                    result.source = 'image_ocr';
                    result.sourceLabel = 'Image Code Detection';
                    result.sourceIcon = 'image';
                } else {
                    result.source = 'text_code';
                    result.sourceLabel = 'Chat Code Detection';
                    result.sourceIcon = 'text';
                }
                result.productCode = msg.metadata?.matchedCode || null;

                const pLog = productLogByMsgId[msg.replyToMessageId?.toString()];
                if (pLog?.productId) {
                    result.productInfo = pLog.productId;
                }
            } else {
                const msgTime = new Date(msg.createdAt).getTime();
                const chatIdStr = msg.chatId?._id?.toString();
                const matchingExec = botExecutions.find(exec => {
                    if (exec.chatId?.toString() !== chatIdStr) return false;
                    const startTime = new Date(exec.startedAt).getTime();
                    const endTime = exec.completedAt ? new Date(exec.completedAt).getTime() : startTime + 60000;
                    return msgTime >= startTime && msgTime <= endTime + 5000;
                });
                if (matchingExec?.flowId) {
                    result.flowName = matchingExec.flowId.name || 'Unknown Flow';
                }
            }

            return result;
        });

        res.json({ data: enriched, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
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
    getAutoMessages,
    getAllAutoMessages,
    stats,
    toggleDnd,
};
