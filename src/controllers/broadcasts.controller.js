const { Broadcast, BroadcastList, BroadcastListMember, BroadcastMessage, BroadcastBatch, Template, Contact } = require('../models');
const whatsappService = require('../services/whatsapp.service');
const broadcastService = require('../services/broadcast.service');
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
            const bodyPhones = req.body.targetPhoneNumbers;
            // Only keep these if we're filtering
            phoneNumbers = phoneNumbers.filter(p => bodyPhones.includes(p));
        }

        // Deduplicate
        phoneNumbers = [...new Set(phoneNumbers)];

        if (phoneNumbers.length === 0) {
            return res.status(400).json({ success: false, message: 'No valid contacts to send to. All selected contacts might be opted-out or blocked.' });
        }

        // 4. Calculate batches
        const { batches, totalBatches } = broadcastService.calculateBatches(phoneNumbers.length, messagingLimit, sentToday);

        // ⭐ NEW: Extract custom batch size from request (optional)
        const customBatchSize = req.body.batchSize ? Math.min(Math.max(parseInt(req.body.batchSize), 1), 10) : null;

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
            customBatchSize, // ⭐ NEW: Store custom batch size for adaptive batching
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

async function getFailedMessages(req, res, next) {
    try {
        const { page = 1, limit = 50 } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const broadcastId = req.params.id;

        const [failedMessages, total] = await Promise.all([
            BroadcastMessage.find({ broadcastId, status: 'failed' })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('contactId', 'name nameOnWhatsApp profilePicture'),
            BroadcastMessage.countDocuments({ broadcastId, status: 'failed' }),
        ]);

        // ⭐ NEW: Classify errors and generate summary
        const errorClassifier = require('../services/whatsapp-error-classifier.service');
        
        // Group by classification to understand the issue breakdown
        const grouped = errorClassifier.groupByClassification(failedMessages);
        const summary = errorClassifier.generateErrorSummary(failedMessages);
        
        // Add detailed error info to each message
        const enrichedMessages = failedMessages.map(msg => ({
            ...msg.toObject(),
            classification: msg.errorClassification || errorClassifier.classifyError(msg.errorCode).classification,
            recommendation: msg.errorRecommendation || errorClassifier.classifyError(msg.errorCode, msg.errorMessage).recommendation,
            isRetryable: errorClassifier.isRetryable(msg.errorCode),
            autoRetryable: errorClassifier.isAutoRetryable(msg.errorCode),
            details: errorClassifier.classifyError(msg.errorCode, msg.errorMessage),
        }));

        res.json({ 
            data: enrichedMessages, 
            total, 
            page: parseInt(page, 10), 
            limit: parseInt(limit, 10),
            // ⭐ NEW: Include summary for dashboard display
            summary: {
                total: summary.total,
                byClassification: summary.byClassification,
                byErrorCode: summary.byErrorCode,
                recommendations: summary.recommendations,
            },
            groupedByClassification: {
                retryableTransient: grouped.RETRYABLE_TRANSIENT.length,
                retryableThrottled: grouped.RETRYABLE_THROTTLED.length,
                nonRetryable: grouped.NON_RETRYABLE.length,
                investigate: grouped.INVESTIGATE.length,
            },
        });
    } catch (e) {
        next(e);
    }
}

async function retryFailed(req, res, next) {
    try {
        const { selectedPhoneNumbers = [] } = req.body;
        const broadcastId = req.params.id;

        const originalBroadcast = await Broadcast.findById(broadcastId).populate('templateId');
        if (!originalBroadcast) {
            return res.status(404).json({ success: false, message: 'Broadcast not found' });
        }

        // ⭐ NEW: Get error classification service
        const errorClassifier = require('../services/whatsapp-error-classifier.service');

        // Get failed messages (either all or selected ones)
        let failedQuery = { broadcastId, status: 'failed' };
        if (selectedPhoneNumbers && selectedPhoneNumbers.length > 0) {
            failedQuery.phoneNumber = { $in: selectedPhoneNumbers };
        }

        const failedMessages = await BroadcastMessage.find(failedQuery).select('phoneNumber contactId errorCode errorClassification retryAttempts maxRetryAttempts');

        if (failedMessages.length === 0) {
            return res.status(400).json({ success: false, message: 'No failed messages found to retry' });
        }

        // ⭐ NEW: Filter messages based on error classification
        // Only retry messages that are actually retryable
        const retryableMessages = [];
        const nonRetryableMessages = [];
        const throttledMessages = [];

        for (const msg of failedMessages) {
            const classification = msg.errorClassification || errorClassifier.classifyError(msg.errorCode).classification;
            
            // Check if message can still be retried
            if (msg.retryAttempts >= msg.maxRetryAttempts && msg.maxRetryAttempts > 0) {
                nonRetryableMessages.push({ phone: msg.phoneNumber, reason: `Retry limit reached (${msg.retryAttempts}/${msg.maxRetryAttempts})` });
                continue;
            }

            if (classification === 'RETRYABLE_TRANSIENT') {
                retryableMessages.push(msg);
            } else if (classification === 'RETRYABLE_THROTTLED') {
                throttledMessages.push(msg);
            } else {
                nonRetryableMessages.push({ phone: msg.phoneNumber, reason: `Error ${msg.errorCode} is ${classification}` });
            }
        }

        if (retryableMessages.length === 0 && throttledMessages.length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'No retryable messages found',
                details: {
                    total: failedMessages.length,
                    nonRetryable: nonRetryableMessages.length,
                    throttled: throttledMessages.length,
                    nonRetryableReasons: nonRetryableMessages.slice(0, 5), // Show first 5
                    recommendation: throttledMessages.length > 0 
                        ? '⚠️ Some messages are throttled. Reduce sending rate and try again later.'
                        : 'No messages are eligible for retry. Review error classifications.',
                }
            });
        }

        // ⭐ NEW: Check for throttling and warn
        if (throttledMessages.length > 0) {
            logger.warn(`[RETRY] ${throttledMessages.length} messages have RETRYABLE_THROTTLED errors. This may indicate rate limiting or account quality issues.`);
        }

        const failedPhoneNumbers = retryableMessages.map(m => m.phoneNumber);

        // Create a new broadcast campaign for the retry (only retryable messages)
        const retryBroadcast = new Broadcast({
            name: `${originalBroadcast.name} - Retry #${new Date().getTime()}`,
            wabaId: originalBroadcast.wabaId,
            phoneNumberId: originalBroadcast.phoneNumberId,
            templateId: originalBroadcast.templateId._id,
            status: 'draft',
            createdBy: req.user._id,
            components: originalBroadcast.components,
            variableMapping: originalBroadcast.variableMapping,
            metadata: {
                retryOf: broadcastId,
                originalBroadcastName: originalBroadcast.name,
                retryCount: 1,
                retryableCount: retryableMessages.length,
                throttledCount: throttledMessages.length,
                nonRetryableCount: nonRetryableMessages.length,
            },
        });

        await retryBroadcast.save();

        // Create a broadcast list for the retry recipients (only retryable)
        const broadcastListName = `${originalBroadcast.name} - Retryable Recipients (${new Date().toLocaleString()})`;
        const retryList = new BroadcastList({
            name: broadcastListName,
            wabaId: originalBroadcast.wabaId,
            description: `Retryable failed recipients from broadcast: ${originalBroadcast.name}`,
            source: 'manual',
            memberCount: failedPhoneNumbers.length,
        });

        await retryList.save();

        // Add retryable phone numbers as members to the retry list
        const listMembers = retryableMessages.map(msg => ({
            broadcastListId: retryList._id,
            contactId: msg.contactId || undefined,
            phoneNumber: msg.phoneNumber,
            status: 'pending',
        }));

        await BroadcastListMember.insertMany(listMembers);

        // Link the retry list to the retry broadcast
        await Broadcast.findByIdAndUpdate(retryBroadcast._id, { broadcastListId: retryList._id });

        res.json({
            success: true,
            message: `Retry campaign created for ${failedPhoneNumbers.length} retryable recipients`,
            retryBroadcast: {
                _id: retryBroadcast._id,
                name: retryBroadcast.name,
                failedCount: failedPhoneNumbers.length,
                listId: retryList._id,
            },
            // ⭐ NEW: Return detailed breakdown
            breakdown: {
                retryableTransient: retryableMessages.length,
                retryableThrottled: throttledMessages.length,
                nonRetryable: nonRetryableMessages.length,
                throttledWarning: throttledMessages.length > 0 
                    ? `⚠️ WARNING: ${throttledMessages.length} messages failed due to throttling. Consider reducing sending rate.`
                    : null,
                recommendations: {
                    general: 'After retry completes, review remaining failures for further action',
                    throttled: throttledMessages.length > 0 
                        ? 'Reduce BATCH_SIZE or increase delays between batches in broadcast.service.js'
                        : null,
                }
            },
        });
    } catch (e) {
        next(e);
    }
}

/**
 * ⭐ NEW ENDPOINT: Get detailed error analytics for a broadcast
 * Returns breakdown by error code, classification, and recommendations
 */
async function getErrorAnalytics(req, res, next) {
    try {
        const broadcastId = req.params.id;
        
        const errorClassifier = require('../services/whatsapp-error-classifier.service');
        
        // Get all failed messages for this broadcast
        const failedMessages = await BroadcastMessage.find({ broadcastId, status: 'failed' }).select('errorCode errorMessage errorClassification');
        
        if (failedMessages.length === 0) {
            return res.json({ 
                success: true,
                total: 0,
                message: 'No failed messages found',
                summary: null,
            });
        }
        
        // Generate comprehensive error analytics
        const summary = errorClassifier.generateErrorSummary(failedMessages);
        const grouped = errorClassifier.groupByClassification(failedMessages);
        
        // Get specific recommendations per error code
        const errorCodeBreakdown = {};
        for (const [errorCode, count] of Object.entries(summary.byErrorCode)) {
            const classification = errorClassifier.classifyError(parseInt(errorCode));
            errorCodeBreakdown[errorCode] = {
                count,
                classification: classification.classification,
                title: classification.title,
                category: classification.category,
                description: classification.description,
                recommendation: classification.recommendation,
                action: classification.action,
                severity: classification.severity,
                preventiveMeasure: classification.preventiveMeasure,
            };
        }
        
        res.json({
            success: true,
            broadcastId,
            totalFailed: failedMessages.length,
            summary: {
                byClassification: summary.byClassification,
                recommendations: summary.recommendations,
            },
            errorCodeBreakdown,
            actionItems: [
                summary.byClassification.retryableTransient > 0 ? {
                    priority: 'HIGH',
                    action: 'Retry transient failures',
                    count: summary.byClassification.retryableTransient,
                    command: 'Use retry button to send again',
                } : null,
                summary.byClassification.retryableThrottled > 0 ? {
                    priority: 'CRITICAL',
                    action: 'Address throttling issues',
                    count: summary.byClassification.retryableThrottled,
                    command: 'Reduce sending rate, check phone quality in WhatsApp Manager',
                } : null,
                summary.byClassification.nonRetryable > 0 ? {
                    priority: 'MEDIUM',
                    action: 'Clean up invalid recipients',
                    count: summary.byClassification.nonRetryable,
                    command: 'Validate phone numbers and remove invalid ones',
                } : null,
                summary.byClassification.investigate > 0 ? {
                    priority: 'MEDIUM',
                    action: 'Investigate configuration issues',
                    count: summary.byClassification.investigate,
                    command: 'Check template, variables, and API configuration',
                } : null,
            ].filter(Boolean),
        });
    } catch (e) {
        next(e);
    }
}

module.exports = { list, create, get, getStats, getTodayStats, getStatusCounts, send, test, getMessages, getBatches, bulkDelete, getFailedMessages, retryFailed, getErrorAnalytics };



