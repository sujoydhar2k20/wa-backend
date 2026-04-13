const { Broadcast, BroadcastBatch, BroadcastMessage, BroadcastListMember, Waba, Contact } = require('../models');
const whatsappService = require('./whatsapp.service');
const { getIO } = require('../websocket/socket.server');
const { logger } = require('../utils/logger');

/**
 * Get the messaging limit for a WABA phone number.
 * Fetches from Meta API and caches on the WABA document.
 */
async function getMessagingLimit(wabaId, phoneNumberId) {
  const waba = await Waba.findById(wabaId);
  if (!waba) throw new Error('WABA not found');

  // Check if we have a cached value (less than 24h old)
  const phoneEntry = waba.phoneNumbers.find(pn => pn.phoneNumberId === phoneNumberId);
  if (phoneEntry && phoneEntry.messagingLimitTier) {
    return {
      messagingLimitTier: phoneEntry.messagingLimitTier,
      messagingLimit: phoneEntry.messagingLimit || whatsappService.resolveMessagingLimit(phoneEntry.messagingLimitTier),
    };
  }

  // Fetch from Meta API
  try {
    const limitData = await whatsappService.getPhoneNumberMessagingLimit(wabaId, phoneNumberId);

    // Cache on the WABA document
    if (phoneEntry) {
      phoneEntry.messagingLimitTier = limitData.messagingLimitTier;
      phoneEntry.messagingLimit = limitData.messagingLimit;
      await waba.save();
    }

    return limitData;
  } catch (err) {
    logger.warn(`Failed to fetch messaging limit for phone ${phoneNumberId}, using default 1000:`, err.message);
    return { messagingLimitTier: 'TIER_1K', messagingLimit: 1000 };
  }
}

/**
 * Count how many broadcast messages were sent today for a specific WABA phone number.
 */
async function getSentTodayCount(wabaId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  // Find all broadcasts for this WABA that were active today
  const broadcasts = await Broadcast.find({
    wabaId,
    status: { $in: ['sending', 'completed', 'paused'] },
    startedAt: { $lte: endOfDay },
  }).select('_id');

  if (broadcasts.length === 0) return 0;

  const broadcastIds = broadcasts.map(b => b._id);

  const count = await BroadcastMessage.countDocuments({
    broadcastId: { $in: broadcastIds },
    status: { $in: ['sent', 'delivered', 'read'] },
    createdAt: { $gte: startOfDay, $lte: endOfDay },
  });

  return count;
}

/**
 * Calculate how to split members into daily batches.
 * @returns {{ batches: { start: number, end: number, scheduledAt: Date }[], totalBatches: number }}
 */
function calculateBatches(totalMembers, dailyLimit, sentToday = 0) {
  if (dailyLimit === Infinity) {
    // Unlimited tier – send everything in one batch
    return {
      batches: [{ start: 0, end: totalMembers, scheduledAt: new Date() }],
      totalBatches: 1,
    };
  }

  const remainingToday = Math.max(0, dailyLimit - sentToday);
  const batches = [];
  let offset = 0;
  let dayOffset = 0;

  // First batch: whatever fits today
  if (remainingToday > 0 && offset < totalMembers) {
    const batchSize = Math.min(remainingToday, totalMembers - offset);
    const scheduledAt = new Date();
    batches.push({ start: offset, end: offset + batchSize, scheduledAt });
    offset += batchSize;
    dayOffset++;
  }

  // Subsequent batches: dailyLimit per day
  while (offset < totalMembers) {
    const batchSize = Math.min(dailyLimit, totalMembers - offset);
    const scheduledAt = new Date();
    scheduledAt.setDate(scheduledAt.getDate() + dayOffset);
    scheduledAt.setHours(9, 0, 0, 0); // Schedule at 9 AM next day
    batches.push({ start: offset, end: offset + batchSize, scheduledAt });
    offset += batchSize;
    dayOffset++;
  }

  return { batches, totalBatches: batches.length };
}

/**
 * Process a single broadcast batch – sends messages to all members in the batch.
 */
async function processBroadcastBatch(batchId) {
  const batch = await BroadcastBatch.findById(batchId);
  if (!batch || batch.status !== 'pending') {
    logger.warn(`Batch ${batchId} not found or already processed (status: ${batch?.status})`);
    return;
  }

  const broadcast = await Broadcast.findById(batch.broadcastId).populate('templateId');
  if (!broadcast) {
    logger.error(`Broadcast not found for batch ${batchId}`);
    await BroadcastBatch.findByIdAndUpdate(batchId, { status: 'failed' });
    return;
  }

  // Check daily limit again before sending (in case other broadcasts used up quota)
  const { messagingLimit } = await getMessagingLimit(broadcast.wabaId, broadcast.phoneNumberId);
  const sentToday = await getSentTodayCount(broadcast.wabaId);
  const remainingToday = messagingLimit === Infinity ? Infinity : Math.max(0, messagingLimit - sentToday);

  if (remainingToday === 0 && messagingLimit !== Infinity) {
    // Reschedule to next day
    const nextDay = new Date();
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(9, 0, 0, 0);
    await BroadcastBatch.findByIdAndUpdate(batchId, { scheduledAt: nextDay });
    logger.info(`Batch ${batchId} rescheduled to ${nextDay} – daily limit reached`);

    // Schedule the agenda job for the new time
    const { getAgenda } = require('../jobs/agenda');
    const agenda = getAgenda();
    if (agenda) {
      await agenda.schedule(nextDay, 'process-broadcast-batch', { batchId: batchId.toString() });
    }
    return;
  }

  // Mark batch as sending
  await BroadcastBatch.findByIdAndUpdate(batchId, { status: 'sending', startedAt: new Date() });

  // Update broadcast status
  await Broadcast.findByIdAndUpdate(broadcast._id, {
    status: 'sending',
    currentBatch: batch.batchNumber,
    ...(batch.batchNumber === 1 ? { startedAt: new Date() } : {}),
  });

  const template = broadcast.templateId;
  let sentCount = 0;
  let failedCount = 0;

  // Get the components from the broadcast (stored when the send was initiated)
  const components = broadcast.components || [];

  // Process each phone number in the batch
  const phonesToSend = batch.memberPhones.slice(0, messagingLimit === Infinity ? undefined : remainingToday);
  const phonesDeferred = batch.memberPhones.slice(messagingLimit === Infinity ? batch.memberPhones.length : remainingToday);

  for (const phoneNumber of phonesToSend) {
    try {
      // Find the member or contact
      let contactId = null;
      let isBlocked = false;
      let isOptedOut = false;

      if (broadcast.broadcastListId) {
        const member = await BroadcastListMember.findOne({
          broadcastListId: broadcast.broadcastListId,
          phoneNumber,
        }).populate('contactId', 'isBlocked isOptedOut');

        if (member) {
          contactId = member.contactId?._id;
          isBlocked = member.contactId?.isBlocked;
          isOptedOut = member.contactId?.isOptedOut;
        }
      }

      // If no member found or no list used, check Contact model directly
      if (!contactId) {
        const contact = await Contact.findOne({ phoneNumber });
        if (contact) {
          contactId = contact._id;
          isBlocked = contact.isBlocked;
          isOptedOut = contact.isOptedOut;
        }
      }

      if (isBlocked || isOptedOut) {
        const skipErr = new Error('Contact is blocked or opted-out');
        skipErr.name = 'SkipContactError';
        throw skipErr;
      }

      const result = await whatsappService.sendTemplateMessage(
        broadcast.wabaId,
        broadcast.phoneNumberId,
        phoneNumber,
        template.name,
        template.language,
        components
      );

      let messageId = null;
      if (result && result.messages && result.messages.length > 0) {
        messageId = result.messages[0].id;
      }

      await BroadcastMessage.create({
        broadcastId: broadcast._id,
        contactId,
        phoneNumber,
        messageId,
        status: 'sent',
      });

      if (broadcast.broadcastListId) {
        await BroadcastListMember.updateOne(
          { broadcastListId: broadcast.broadcastListId, phoneNumber },
          { status: 'sent' }
        );
      }
      sentCount++;
    } catch (err) {
      const isSkipped = err.name === 'SkipContactError';
      
      await BroadcastMessage.create({
        broadcastId: broadcast._id,
        contactId,
        phoneNumber,
        status: isSkipped ? 'skipped' : 'failed',
        errorCode: err.response?.data?.error?.code || (isSkipped ? 403 : 500),
        errorMessage: err.response?.data?.error?.message || err.message,
      });

      if (broadcast.broadcastListId) {
        await BroadcastListMember.updateOne(
          { broadcastListId: broadcast.broadcastListId, phoneNumber },
          { status: isSkipped ? 'opted_out' : 'failed' }
        );
      }
      
      if (isSkipped) {
        sentCount++; // We count skipped as "processed" in the batch loop but handle stat specifically below
      } else {
        failedCount++;
      }
    }
  }

  // If some phones exceeded the daily limit mid-batch, create a spillover batch
  if (phonesDeferred.length > 0) {
    const nextDay = new Date();
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(9, 0, 0, 0);

    const spilloverBatch = await BroadcastBatch.create({
      broadcastId: broadcast._id,
      batchNumber: batch.batchNumber + 0.5, // intermediate batch
      scheduledAt: nextDay,
      status: 'pending',
      memberPhones: phonesDeferred,
      memberCount: phonesDeferred.length,
    });

    // Schedule via Agenda
    const { getAgenda } = require('../jobs/agenda');
    const agenda = getAgenda();
    if (agenda) {
      await agenda.schedule(nextDay, 'process-broadcast-batch', { batchId: spilloverBatch._id.toString() });
    }
  }

  // Update batch stats
  const batchSkippedCount = await BroadcastMessage.countDocuments({ 
    broadcastId: broadcast._id, 
    status: 'skipped',
    createdAt: { $gte: batch.startedAt || new Date() } // Rough filter for current batch
  });

  await BroadcastBatch.findByIdAndUpdate(batchId, {
    status: 'completed',
    completedAt: new Date(),
    sentCount: sentCount - batchSkippedCount, // Actual sent are successful ones
    failedCount,
  });

  // Update broadcast statistics
  const allBatchMessages = await BroadcastMessage.countDocuments({ broadcastId: broadcast._id, status: 'sent' });
  const allBatchFailed = await BroadcastMessage.countDocuments({ broadcastId: broadcast._id, status: 'failed' });
  const allBatchSkipped = await BroadcastMessage.countDocuments({ broadcastId: broadcast._id, status: 'skipped' });
  const totalRecipients = await BroadcastMessage.countDocuments({ broadcastId: broadcast._id });

  // Check if there are more pending batches
  const pendingBatches = await BroadcastBatch.countDocuments({
    broadcastId: broadcast._id,
    status: 'pending',
  });

  const nextPendingBatch = await BroadcastBatch.findOne({
    broadcastId: broadcast._id,
    status: 'pending',
  }).sort({ batchNumber: 1 });

  const broadcastUpdate = {
    'statistics.sent': allBatchMessages,
    'statistics.failed': allBatchFailed,
    'statistics.optedOut': allBatchSkipped,
    'statistics.total': totalRecipients + (pendingBatches > 0 ?
      (await BroadcastBatch.aggregate([
        { $match: { broadcastId: broadcast._id, status: 'pending' } },
        { $group: { _id: null, total: { $sum: '$memberCount' } } }
      ]))[0]?.total || 0 : 0),
  };

  if (pendingBatches === 0) {
    broadcastUpdate.status = 'completed';
    broadcastUpdate.completedAt = new Date();
    broadcastUpdate.nextBatchAt = null;
  } else {
    broadcastUpdate.status = 'paused';
    broadcastUpdate.nextBatchAt = nextPendingBatch?.scheduledAt;
  }

  const updatedBroadcast = await Broadcast.findByIdAndUpdate(broadcast._id, broadcastUpdate, { new: true });

  // Emit socket event
  try {
    const io = getIO();
    io.emit('broadcast:update', updatedBroadcast);
  } catch (e) {
    logger.warn('Socket emit failed for broadcast batch update:', e.message);
  }
}

module.exports = {
  getMessagingLimit,
  getSentTodayCount,
  calculateBatches,
  processBroadcastBatch,
};
