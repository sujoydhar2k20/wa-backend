const { Broadcast, BroadcastList, BroadcastListMember, BroadcastMessage, Template } = require('../models');
const whatsappService = require('../services/whatsapp.service');
const { getIO } = require('../websocket/socket.server');

async function list(req, res, next) {
    try {
        const { page = 1, limit = 20, wabaId, status } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = {};
        if (wabaId) filter.wabaId = wabaId;
        if (status) filter.status = status;
        const [broadcasts, total] = await Promise.all([
            Broadcast.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('templateId', 'name language status')
                .populate('broadcastListId', 'name memberCount'),
            Broadcast.countDocuments(filter),
        ]);
        res.json({ data: broadcasts, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

async function create(req, res, next) {
    try {
        const broadcast = new Broadcast({ ...req.body, createdBy: req.user._id });
        await broadcast.save();
        res.status(201).json(broadcast);
    } catch (e) {
        next(e);
    }
}

async function get(req, res, next) {
    try {
        const broadcast = await Broadcast.findById(req.params.id)
            .populate('templateId', 'name language status components')
            .populate('broadcastListId', 'name memberCount')
            .populate('createdBy', 'name phone');
        if (!broadcast) return res.status(404).json({ success: false, message: 'Broadcast not found' });
        res.json(broadcast);
    } catch (e) {
        next(e);
    }
}

async function getStats(req, res, next) {
    try {
        const broadcast = await Broadcast.findById(req.params.id).select('statistics status startedAt completedAt');
        if (!broadcast) return res.status(404).json({ success: false, message: 'Broadcast not found' });
        res.json(broadcast);
    } catch (e) {
        next(e);
    }
}

async function send(req, res, next) {
    try {
        const broadcast = await Broadcast.findById(req.params.id).populate('templateId');
        if (!broadcast) return res.status(404).json({ success: false, message: 'Broadcast not found' });
        if (!['draft', 'scheduled'].includes(broadcast.status)) {
            return res.status(400).json({ success: false, message: 'Broadcast cannot be sent in its current status' });
        }

        const members = await BroadcastListMember.find({
            broadcastListId: broadcast.broadcastListId,
            status: { $ne: 'opted_out' } // Send to everyone except those who opted out
        });

        // Mark as sending first
        await Broadcast.findByIdAndUpdate(broadcast._id, {
            status: 'sending',
            startedAt: new Date(),
            'statistics.total': members.length,
        });

        // Dispatch asynchronously – fire and forget, don't block the response
        setImmediate(async () => {
            let sentCount = 0;
            let failedCount = 0;
            for (const member of members) {
                try {
                    const template = broadcast.templateId;
                    const result = await whatsappService.sendTemplateMessage(
                        broadcast.wabaId,
                        broadcast.phoneNumberId,
                        member.phoneNumber,
                        template.name,
                        template.language,
                        req.body.components || []
                    );

                    let messageId = null;
                    if (result && result.messages && result.messages.length > 0) {
                        messageId = result.messages[0].id;
                    }

                    await BroadcastMessage.create({
                        broadcastId: broadcast._id,
                        contactId: member.contactId,
                        phoneNumber: member.phoneNumber,
                        messageId: messageId,
                        status: 'sent',
                    });

                    await BroadcastListMember.findByIdAndUpdate(member._id, { status: 'sent' });
                    sentCount++;
                } catch (err) {
                    await BroadcastMessage.create({
                        broadcastId: broadcast._id,
                        contactId: member.contactId,
                        phoneNumber: member.phoneNumber,
                        status: 'failed',
                        errorCode: err.response?.data?.error?.code || 500,
                        errorMessage: err.response?.data?.error?.message || err.message,
                    });

                    await BroadcastListMember.findByIdAndUpdate(member._id, { status: 'failed' });
                    failedCount++;
                }
            }
            const updatedBroadcast = await Broadcast.findByIdAndUpdate(broadcast._id, {
                status: 'completed',
                completedAt: new Date(),
                'statistics.sent': sentCount,
                'statistics.failed': failedCount,
            }, { new: true });

            try {
                const io = getIO();
                io.emit('broadcast:update', updatedBroadcast);
            } catch (e) {
                console.warn('Socket emit failed for broadcast completion:', e.message);
            }
        });

        res.json({ success: true, message: 'Broadcast sending initiated', total: members.length });
    } catch (e) {
        next(e);
    }
}

async function test(req, res, next) {
    try {
        const broadcast = await Broadcast.findById(req.params.id).populate('templateId');
        if (!broadcast) return res.status(404).json({ success: false, message: 'Broadcast not found' });

        const { testPhoneNumber, components = [] } = req.body;
        if (!testPhoneNumber) return res.status(400).json({ success: false, message: 'testPhoneNumber is required' });

        const template = broadcast.templateId;
        const result = await whatsappService.sendTemplateMessage(
            broadcast.wabaId,
            broadcast.phoneNumberId,
            testPhoneNumber,
            template.name,
            template.language,
            components
        );

        res.json({ success: true, result });
    } catch (e) {
        next(e);
    }
}

async function getMessages(req, res, next) {
    try {
        const { page = 1, limit = 50 } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = { broadcastId: req.params.id };

        const [messages, total] = await Promise.all([
            BroadcastMessage.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('contactId', 'name nameOnWhatsApp profilePicture'),
            BroadcastMessage.countDocuments(filter),
        ]);

        res.json({ data: messages, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

module.exports = { list, create, get, getStats, send, test, getMessages };
