const { Broadcast, BroadcastList, BroadcastListMember, BroadcastMessage, BroadcastBatch, Template, Contact } = require('../models');
const whatsappService = require('../services/whatsapp.service');
const broadcastService = require('../services/broadcast.service');
const { getIO } = require('../websocket/socket.server');
const { normalizePhone } = require('../utils/waIdentity');

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
        const broadcast = await Broadcast.findById(req.params.id).select('statistics status startedAt completedAt totalBatches currentBatch nextBatchAt dailyLimit');
        if (!broadcast) return res.status(404).json({ success: false, message: 'Broadcast not found' });

        // Also fetch batch details
        const batches = await BroadcastBatch.find({ broadcastId: req.params.id }).sort({ batchNumber: 1 });
        res.json({ ...broadcast.toObject(), batches });
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

        // 1. Fetch the messaging limit for this phone number
        const { messagingLimit, messagingLimitTier } = await broadcastService.getMessagingLimit(
            broadcast.wabaId,
            broadcast.phoneNumberId
        );

        // 2. Count messages already sent today for this WABA
        const sentToday = await broadcastService.getSentTodayCount(broadcast.wabaId);

        // 3. Get members to send to
        let phoneNumbers = [];
        const contactMap = new Map(); // Untuk menyimpan mapping phone -> contactId

        // A. From Broadcast List
        if (broadcast.broadcastListId) {
            const listMembers = await BroadcastListMember.find({
                broadcastListId: broadcast.broadcastListId,
                status: { $ne: 'opted_out' },
            }).populate('contactId', 'isBlocked isOptedOut');

            listMembers.forEach(m => {
                if (m.contactId && (m.contactId.isBlocked || m.contactId.isOptedOut)) return;
                phoneNumbers.push(m.phoneNumber);
                if (m.contactId) contactMap.set(m.phoneNumber, m.contactId._id);
            });
        }

        // B. From Tags
        if (broadcast.tagIds && broadcast.tagIds.length > 0) {
            const taggedContacts = await Contact.find({
                tags: { $in: broadcast.tagIds },
                isBlocked: { $ne: true },
                isOptedOut: { $ne: true }
            });

            taggedContacts.forEach(c => {
                phoneNumbers.push(c.phoneNumber);
                contactMap.set(c.phoneNumber, c._id);
            });
        }

        // C. Target Specific Phone Numbers (if provided in request body)
        if (req.body.targetPhoneNumbers && Array.isArray(req.body.targetPhoneNumbers) && req.body.targetPhoneNumbers.length > 0) {
            const bodyPhones = new Set(req.body.targetPhoneNumbers.map((p) => normalizePhone(p)).filter(Boolean));
            // Only keep these if we're filtering (compared in full international form)
            phoneNumbers = phoneNumbers.filter(p => bodyPhones.has(normalizePhone(p)));
        }

        // Deduplicate by the full international number, so "9874085669" and "919874085669" (one
        // customer stored both ways) get ONE message. The stored form is kept: the batch job uses
        // it to find the list member, and sends to the normalised number. Rows without a phone
        // (customers known only by WhatsApp user ID) are skipped: they used to fail one by one.
        const byFull = new Map();
        for (const p of phoneNumbers) {
            const full = normalizePhone(p);
            if (full && !byFull.has(full)) byFull.set(full, p);
        }
        phoneNumbers = [...byFull.values()];

        if (phoneNumbers.length === 0) {
            return res.status(400).json({ success: false, message: 'No valid contacts to send to. All selected contacts might be opted-out or blocked.' });
        }

        // 4. Calculate batches
        const { batches, totalBatches } = broadcastService.calculateBatches(phoneNumbers.length, messagingLimit, sentToday);

        // 5. Save broadcast metadata
        await Broadcast.findByIdAndUpdate(broadcast._id, {
            status: 'sending',
            startedAt: new Date(),
            totalBatches,
            currentBatch: 1,
            dailyLimit: messagingLimit === Infinity ? null : messagingLimit,
            'statistics.total': phoneNumbers.length,
            components: req.body.components || [],
            variableMapping: req.body.variableMapping || [],
            nextBatchAt: totalBatches > 1 ? batches[1]?.scheduledAt : null,
        });

        // 6. Create BroadcastBatch documents and schedule jobs
        const batchDocs = [];
        for (let i = 0; i < batches.length; i++) {
            const b = batches[i];
            const batchPhones = phoneNumbers.slice(b.start, b.end);
            const batchDoc = await BroadcastBatch.create({
                broadcastId: broadcast._id,
                batchNumber: i + 1,
                scheduledAt: b.scheduledAt,
                status: i === 0 ? 'pending' : 'pending',
                memberPhones: batchPhones,
                memberCount: batchPhones.length,
            });
            batchDocs.push(batchDoc);
        }

        // 7. Process today's batch immediately (batch 0)
        if (batchDocs.length > 0) {
            setImmediate(async () => {
                try {
                    await broadcastService.processBroadcastBatch(batchDocs[0]._id);
                } catch (err) {
                    console.error('Failed to process first batch:', err.message);
                }
            });
        }

        // 8. Schedule future batches via Agenda
        if (batchDocs.length > 1) {
            try {
                const { getAgenda } = require('../jobs/agenda');
                const agenda = getAgenda();
                if (agenda) {
                    for (let i = 1; i < batchDocs.length; i++) {
                        await agenda.schedule(
                            batchDocs[i].scheduledAt,
                            'process-broadcast-batch',
                            { batchId: batchDocs[i]._id.toString() }
                        );
                    }
                }
            } catch (agendaErr) {
                console.error('Failed to schedule future batches via Agenda:', agendaErr.message);
            }
        }

        // 9. Respond with batching info
        const batchInfo = batches.map((b, i) => ({
            batchNumber: i + 1,
            memberCount: b.end - b.start,
            scheduledAt: b.scheduledAt,
        }));

        res.json({
            success: true,
            message: totalBatches > 1
                ? `Broadcast will be sent in ${totalBatches} batches over ${totalBatches} days (daily limit: ${messagingLimit === Infinity ? 'Unlimited' : messagingLimit.toLocaleString()})`
                : 'Broadcast sending initiated',
            total: phoneNumbers.length,
            dailyLimit: messagingLimit === Infinity ? 'Unlimited' : messagingLimit,
            messagingLimitTier,
            sentToday,
            totalBatches,
            batches: batchInfo,
        });
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

async function getBatches(req, res, next) {
    try {
        const batches = await BroadcastBatch.find({ broadcastId: req.params.id }).sort({ batchNumber: 1 });
        res.json(batches);
    } catch (e) {
        next(e);
    }
}

async function getTodayStats(req, res, next) {
    try {
        const { wabaId } = req.query;
        const now = new Date();
        const startOfDay = new Date(now.setHours(0, 0, 0, 0));
        const endOfDay = new Date(now.setHours(23, 59, 59, 999));

        const filter = {
            $or: [
                { createdAt: { $gte: startOfDay, $lte: endOfDay } },
                { startedAt: { $gte: startOfDay, $lte: endOfDay } }
            ]
        };

        if (wabaId) {
            filter.wabaId = wabaId;
        }

        const broadcasts = await Broadcast.find(filter);

        let totalBroadcasts = broadcasts.length;
        let totalRecipients = 0;
        let totalDelivered = 0;
        let totalRead = 0;

        broadcasts.forEach(b => {
            const stats = b.statistics || {};
            totalRecipients += (stats.total || 0);
            totalDelivered += (stats.delivered || 0);
            totalRead += (stats.read || 0);
        });

        res.json({
            success: true,
            data: {
                broadcasts: totalBroadcasts,
                recipients: totalRecipients,
                delivered: totalDelivered,
                read: totalRead
            }
        });
    } catch (e) {
        next(e);
    }
}

async function getStatusCounts(req, res, next) {
    try {
        const { wabaId } = req.query;
        const filter = {};
        if (wabaId) filter.wabaId = wabaId;

        const [draft, scheduled, completed, sending, paused, failed] = await Promise.all([
            Broadcast.countDocuments({ ...filter, status: 'draft' }),
            Broadcast.countDocuments({ ...filter, status: 'scheduled' }),
            Broadcast.countDocuments({ ...filter, status: 'completed' }),
            Broadcast.countDocuments({ ...filter, status: 'sending' }),
            Broadcast.countDocuments({ ...filter, status: 'paused' }),
            Broadcast.countDocuments({ ...filter, status: 'failed' }),
        ]);

        res.json({
            success: true,
            data: {
                draft,
                scheduled,
                completed,
                sending,
                paused,
                failed,
                total: draft + scheduled + completed + sending + paused + failed
            }
        });
    } catch (e) {
        next(e);
    }
}

async function bulkDelete(req, res, next) {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or empty IDs list' });
        }

        await Promise.all([
            Broadcast.deleteMany({ _id: { $in: ids } }),
            BroadcastBatch.deleteMany({ broadcastId: { $in: ids } }),
            BroadcastMessage.deleteMany({ broadcastId: { $in: ids } })
        ]);

        res.json({ success: true });
    } catch (e) {
        next(e);
    }
}

async function pause(req, res, next) {
    try {
        const broadcast = await Broadcast.findById(req.params.id);
        if (!broadcast) return res.status(404).json({ success: false, message: 'Broadcast not found' });
        if (!['sending', 'scheduled'].includes(broadcast.status)) {
            return res.status(400).json({ success: false, message: 'Only sending or scheduled broadcasts can be paused' });
        }

        // Update broadcast as paused
        const updated = await Broadcast.findByIdAndUpdate(
            req.params.id,
            {
                status: 'paused',
                pausedAt: new Date(),
                isPausedManually: true,
            },
            { returnDocument: 'after' }
        );

        // Also pause the current sending batch if any
        await BroadcastBatch.updateOne(
            { broadcastId: req.params.id, status: 'sending' },
            { status: 'paused', pausedAt: new Date() }
        );

        // Emit socket event
        try {
            const io = getIO();
            io.emit('broadcast:update', updated);
        } catch (e) {
            console.warn('Socket emit failed:', e.message);
        }

        res.json({ success: true, message: 'Broadcast paused', broadcast: updated });
    } catch (e) {
        next(e);
    }
}

async function resume(req, res, next) {
    try {
        const broadcast = await Broadcast.findById(req.params.id);
        if (!broadcast) return res.status(404).json({ success: false, message: 'Broadcast not found' });
        if (broadcast.status !== 'paused') {
            return res.status(400).json({ success: false, message: 'Only paused broadcasts can be resumed' });
        }

        // Update broadcast as sending
        const updated = await Broadcast.findByIdAndUpdate(
            req.params.id,
            {
                status: 'sending',
                resumedAt: new Date(),
                isPausedManually: false,
            },
            { returnDocument: 'after' }
        );

        // Resume the paused batch
        const pausedBatch = await BroadcastBatch.findOne({ broadcastId: req.params.id, status: 'paused' });
        if (pausedBatch) {
            await BroadcastBatch.updateOne(
                { _id: pausedBatch._id },
                { status: 'pending' }
            );

            // Immediately process the batch
            setImmediate(async () => {
                try {
                    const { logger } = require('../utils/logger');
                    await broadcastService.processBroadcastBatch(pausedBatch._id);
                } catch (err) {
                    const { logger } = require('../utils/logger');
                    logger.error('Failed to resume batch:', err.message);
                }
            });
        }

        // Emit socket event
        try {
            const io = getIO();
            io.emit('broadcast:update', updated);
        } catch (e) {
            console.warn('Socket emit failed:', e.message);
        }

        res.json({ success: true, message: 'Broadcast resumed', broadcast: updated });
    } catch (e) {
        next(e);
    }
}

async function getFailedMessages(req, res, next) {
    try {
        const { page = 1, limit = 50 } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

        const [messages, total] = await Promise.all([
            BroadcastMessage.find({ broadcastId: req.params.id, status: 'failed' })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('contactId', 'name nameOnWhatsApp profilePicture'),
            BroadcastMessage.countDocuments({ broadcastId: req.params.id, status: 'failed' }),
        ]);

        res.json({ data: messages, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

async function createRetryBroadcast(req, res, next) {
    try {
        const { name, phoneNumberId } = req.body;
        if (!name || !phoneNumberId) {
            return res.status(400).json({ success: false, message: 'name and phoneNumberId are required' });
        }

        const originalBroadcast = await Broadcast.findById(req.params.id)
            .populate('templateId', 'name language status components');
        if (!originalBroadcast) {
            return res.status(404).json({ success: false, message: 'Original broadcast not found' });
        }

        // Get all failed messages
        const failedMessages = await BroadcastMessage.find({
            broadcastId: req.params.id,
            status: 'failed',
        }).select('phoneNumber');

        if (failedMessages.length === 0) {
            return res.status(400).json({ success: false, message: 'No failed messages found for this broadcast' });
        }

        const phoneNumbers = failedMessages.map(msg => msg.phoneNumber);

        // Create new broadcast with same template
        const newBroadcast = new Broadcast({
            name,
            wabaId: originalBroadcast.wabaId,
            phoneNumberId,
            templateId: originalBroadcast.templateId._id,
            status: 'draft',
            components: originalBroadcast.components,
            variableMapping: originalBroadcast.variableMapping,
            createdBy: req.user._id,
        });

        await newBroadcast.save();

        // Return the new broadcast with the failed phone numbers
        res.status(201).json({
            success: true,
            message: 'Retry campaign created',
            broadcast: newBroadcast,
            failedPhoneNumbers: phoneNumbers,
        });
    } catch (e) {
        next(e);
    }
}

module.exports = { list, create, get, getStats, getTodayStats, getStatusCounts, send, test, getMessages, getBatches, bulkDelete, pause, resume, getFailedMessages, createRetryBroadcast };



