const { Broadcast, BroadcastBatch, BroadcastMessage, BroadcastListMember, Waba, Contact, Chat, Message, Template } = require('../models');
const whatsappService = require('./whatsapp.service');
const { getIO } = require('../websocket/socket.server');
const { logger } = require('../utils/logger');
const { loadChatForSocket } = require('../utils/chatSocket');
const { normalizePhone, phoneVariants } = require('../utils/waIdentity');

/**
 * Utility function to limit concurrency of async operations
 * @param {Function} fn Async function to execute
 * @param {Array} items Items to process
 * @param {number} limit Max concurrent operations (default 5 to respect API rate limits)
 * @returns {Promise<Array>} Results in same order as items
 */
async function pLimit(fn, items, limit = 5) {
  const results = new Array(items.length);
  let activeCount = 0;
  let nextIndex = 0;

  return new Promise((resolve, reject) => {
    const processNext = async () => {
      if (nextIndex >= items.length && activeCount === 0) {
        resolve(results);
        return;
      }

      if (nextIndex < items.length && activeCount < limit) {
        const currentIndex = nextIndex++;
        activeCount++;

        try {
          results[currentIndex] = await fn(items[currentIndex], currentIndex);
        } catch (err) {
          results[currentIndex] = { error: err };
        }

        activeCount--;
        processNext();
      }
    };

    // Start processing
    for (let i = 0; i < Math.min(limit, items.length); i++) {
      processNext();
    }
  });
}

/**
 * The contact for a broadcast recipient. A customer may exist twice (full number from WhatsApp,
 * bare national number from an old import); prefer the full-number contact, which is the one the
 * customer's chats, tags and block / opt-out state belong to.
 */
async function findContactByVariants(variants, full, select) {
  if (!variants.length) return null;
  let q = Contact.find({ phoneNumber: { $in: variants } }).limit(5);
  if (select) q = q.select(`${select} phoneNumber`);
  const found = await q;
  return found.find((c) => c.phoneNumber === full) || found[0] || null;
}

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
    logger.warn(`Failed to fetch messaging limit for phone ${phoneNumberId}, using default 100000:`, err.message);
    return { messagingLimitTier: 'TIER_100K', messagingLimit: 100000 };
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
 * Mirror a sent broadcast template into the customer's chat history.
 *
 * Data-integrity rule: this function must NEVER write ownership fields
 * (assignedTo, collaborators). Existing chats are only touched with a $set of
 * activity timestamps, and a missing chat is created atomically via
 * $setOnInsert, so a concurrent assignment made by staff / the webhook auto-assign
 * can never be overwritten by broadcast processing.
 */
async function recordBroadcastInChat({
  broadcast, template, phoneNumber, contactId, messageId, contactResolvedText, resolvedTemplateComponents,
}) {
  try {
    const waId = phoneNumber.replace(/\D/g, '');
    const now = new Date();

    // Existing chat: untouched here. New chat: created closed + unassigned, atomically.
    const chat = await Chat.findOneAndUpdate(
      { wabaId: broadcast.wabaId, waId },
      {
        $setOnInsert: {
          wabaId: broadcast.wabaId,
          phoneNumberId: broadcast.phoneNumberId,
          phoneNumber: waId,
          waId,
          ...(contactId ? { contactId } : {}),
          status: 'closed',
          lastCustomerMessageAt: new Date(0),
          isUnread: false,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const hostedHeaderUrl = await whatsappService.getTemplateHeaderImageUrl(broadcast.wabaId, template.name, template.language);
    const chatMessage = await Message.create({
      chatId: chat._id,
      wabaId: broadcast.wabaId,
      phoneNumberId: broadcast.phoneNumberId,
      messageId,
      waId,
      direction: 'outbound',
      type: 'template',
      text: contactResolvedText,
      status: 'sent',
      metadata: {
        templateName: template.name,
        templateLanguage: template.language,
        templateComponents: whatsappService.withHostedHeaderImage(resolvedTemplateComponents, hostedHeaderUrl) || undefined,
        templateImageUrl: hostedHeaderUrl || undefined,
        broadcastId: broadcast._id.toString(),
      },
    });

    // Activity timestamps only (explicit $set; no assignment fields).
    await Chat.findByIdAndUpdate(chat._id, { $set: { lastMessageAt: now, lastStaffMessageAt: now } });

    // Emit socket events for real-time chat UI update (non-critical)
    try {
      const io = getIO();
      io.emit('message:new', { chatId: chat._id, message: chatMessage });
      // Fully populated (incl. assignedTo/collaborators) so clients never see a bare id
      // and render the chat as "Unassigned".
      const populatedChat = await loadChatForSocket(chat._id);
      io.emit('chat:update', { chatId: chat._id, chat: populatedChat });
    } catch (socketErr) {
      // Non-critical
    }
  } catch (chatErr) {
    logger.warn(`Failed to create chat message for broadcast ${broadcast._id}, phone ${phoneNumber}: ${chatErr.message}`);
  }
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

  // Get the components from the broadcast (stored when the send was initiated)
  const components = broadcast.components || [];
  const variableMapping = broadcast.variableMapping || [];

  // Check if any variable uses dynamic contact fields
  const hasDynamicVars = variableMapping.some(m => m.source === 'contact_field');

  // Warn if template expects variables but components are empty
  if (components.length === 0 && template.components) {
    const bodyComp = (template.components || []).find(c => (c.type || c.get?.('type')) === 'BODY');
    const bodyText = bodyComp?.text || bodyComp?.get?.('text') || '';
    if (/\{\{\d+\}\}/.test(bodyText)) {
      logger.warn(`Broadcast ${broadcast._id}: Template "${template.name}" has body variables but components array is empty. Messages will likely fail with parameter mismatch error.`);
    }
  }

  /**
   * Resolve components for a specific contact by replacing dynamic placeholders
   * with actual contact field values.
   */
  function resolveComponentsForContact(baseComponents, contactDoc) {
    if (!hasDynamicVars || !contactDoc) return baseComponents;

    return baseComponents.map(comp => {
      const section = comp.type; // 'header', 'body', 'button'
      if (section !== 'header' && section !== 'body') return comp;

      const sectionMappings = variableMapping.filter(m => m.section === section);
      if (sectionMappings.length === 0) return comp;

      const newParams = (comp.parameters || []).map((param, idx) => {
        const mapping = sectionMappings.find(m => m.index === idx);
        if (mapping && mapping.source === 'contact_field' && mapping.field) {
          // Resolve the field value from the contact document
          let fieldValue = '';
          if (mapping.field === 'phoneNumber') {
            fieldValue = contactDoc.phoneNumber || '';
          } else if (mapping.field === 'name') {
            fieldValue = contactDoc.name || contactDoc.nameOnWhatsApp || contactDoc.phoneNumber || '';
          } else if (mapping.field === 'nameOnWhatsApp') {
            fieldValue = contactDoc.nameOnWhatsApp || contactDoc.name || '';
          } else if (mapping.field === 'nickname') {
            fieldValue = contactDoc.nickname || contactDoc.name || '';
          } else {
            // Try custom fields
            fieldValue = contactDoc.customFields?.get?.(mapping.field) 
              || contactDoc.customFields?.[mapping.field] 
              || contactDoc[mapping.field] 
              || '';
          }
          return { ...param, text: fieldValue || ' ' };
        }
        return param;
      });

      return { ...comp, parameters: newParams };
    });
  }

  /**
   * Resolve template text for chat preview for a specific contact
   */
  function resolveTemplateTextForContact(templateDoc, perContactComponents) {
    try {
      let resolvedText = `[Broadcast: ${template.name}]`;
      if (templateDoc) {
        const bodyTemplateComp = (templateDoc.components || []).find(c => {
          const t = c.toObject ? c.toObject() : c;
          return t.type === 'BODY';
        });
        if (bodyTemplateComp) {
          const bt = bodyTemplateComp.toObject ? bodyTemplateComp.toObject() : bodyTemplateComp;
          let text = bt.text || '';
          const bodyVars = (perContactComponents || []).find(v => v.type === 'body');
          if (bodyVars && bodyVars.parameters) {
            bodyVars.parameters.forEach((param, idx) => {
              text = text.replace(`{{${idx + 1}}}`, param.text || `{{${idx + 1}}}`);
            });
          }
          resolvedText = text;
        }
      }
      return resolvedText;
    } catch (err) {
      return `[Broadcast: ${template.name}]`;
    }
  }

  // Pre-resolve template components with variables for chat preview (done once, reused for all recipients)
  // This is used as fallback when there are no dynamic variables
  let resolvedTemplateComponents = null;
  let resolvedTemplateText = `[Broadcast: ${template.name}]`;
  const templateDoc = await Template.findById(template._id || template).catch(() => null);
  try {
    if (templateDoc) {
      resolvedTemplateComponents = (templateDoc.components || []).map(comp => {
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
      const bodyComp = resolvedTemplateComponents.find(c => c.type === 'BODY');
      if (bodyComp?.text) resolvedTemplateText = bodyComp.text;
    }
  } catch (tplErr) {
    logger.warn(`Failed to resolve template components for broadcast ${broadcast._id}: ${tplErr.message}`);
  }

  // Process each phone number in the batch
  const phonesToSend = batch.memberPhones.slice(0, messagingLimit === Infinity ? undefined : remainingToday);
  const phonesDeferred = batch.memberPhones.slice(messagingLimit === Infinity ? batch.memberPhones.length : remainingToday);

  /**
   * OPTIMIZATION: Pre-fetch all contacts for this batch at once (avoid N+1 queries)
   * This is a one-time operation that dramatically speeds up the loop
   */
  const phoneVariantMap = new Map(); // Map phone -> { to, variants, index }
  const allVariants = [];
  
  phonesToSend.forEach((phone, idx) => {
    const to = normalizePhone(phone) || phone;
    const variants = phoneVariants(phone);
    phoneVariantMap.set(to, { phone, to, variants, index: idx });
    allVariants.push(...variants);
  });

  // Fetch all contacts in a single query
  let allContacts = [];
  if (allVariants.length > 0) {
    const populateFields = hasDynamicVars
      ? 'isBlocked isOptedOut name nameOnWhatsApp nickname phoneNumber customFields'
      : '_id isBlocked isOptedOut phoneNumber';
    allContacts = await Contact.find({ phoneNumber: { $in: allVariants } }).select(populateFields);
  }

  // Build a map of phone variants to contacts for O(1) lookup
  const contactLookup = new Map();
  allContacts.forEach(contact => {
    const variants = phoneVariants(contact.phoneNumber);
    variants.forEach(v => {
      if (!contactLookup.has(v)) {
        contactLookup.set(v, contact);
      }
    });
  });

  // Build list of members for broadcast list (if applicable)
  let memberMap = new Map();
  if (broadcast.broadcastListId) {
    const members = await BroadcastListMember.find({
      broadcastListId: broadcast.broadcastListId,
      phoneNumber: { $in: allVariants }
    }).populate('contactId', hasDynamicVars 
      ? 'isBlocked isOptedOut name nameOnWhatsApp nickname phoneNumber customFields'
      : '_id isBlocked isOptedOut phoneNumber');
    members.forEach(m => {
      if (m.contactId) {
        m.contactId.variants = phoneVariants(m.phoneNumber);
        m.contactId.variants.forEach(v => memberMap.set(v, m));
      }
    });
  }

  /**
   * Process messages concurrently with rate limiting
   * Default concurrency of 5 respects WhatsApp API rate limits while parallelizing
   * CRITICAL: Save BroadcastMessage IMMEDIATELY after API call to prevent webhook race condition
   */
  const messageResults = await pLimit(async (phoneNumber) => {
    let contactId = null;
    const to = normalizePhone(phoneNumber) || phoneNumber;
    const variants = phoneVariants(phoneNumber);
    
    try {
      let isBlocked = false;
      let isOptedOut = false;
      let contactDoc = null;

      // Check broadcast list member first (optimized)
      let member = memberMap.get(to) || memberMap.get(variants[0]);
      if (member && member.contactId) {
        contactId = member.contactId._id;
        isBlocked = member.contactId.isBlocked;
        isOptedOut = member.contactId.isOptedOut;
        if (hasDynamicVars) contactDoc = member.contactId;
      }

      // Fallback to contact lookup (already pre-fetched)
      if (!contactId) {
        const contact = contactLookup.get(to) || contactLookup.get(variants[0]);
        if (contact) {
          contactId = contact._id;
          isBlocked = contact.isBlocked;
          isOptedOut = contact.isOptedOut;
          if (hasDynamicVars) contactDoc = contact;
        }
      }

      if (isBlocked || isOptedOut) {
        const skipErr = new Error('Contact is blocked or opted-out');
        skipErr.name = 'SkipContactError';
        throw skipErr;
      }

      // Resolve per-contact components (dynamic fields replaced with actual values)
      const perContactComponents = resolveComponentsForContact(components, contactDoc);

      const result = await whatsappService.sendTemplateMessage(
        broadcast.wabaId,
        broadcast.phoneNumberId,
        to,
        template.name,
        template.language,
        perContactComponents
      );

      let messageId = null;
      if (result && result.messages && result.messages.length > 0) {
        messageId = result.messages[0].id;
      }

      // CRITICAL: Save BroadcastMessage IMMEDIATELY to avoid webhook race condition
      // WhatsApp can call webhook within milliseconds, so we must save now
      await BroadcastMessage.create({
        broadcastId: broadcast._id,
        contactId,
        phoneNumber: to,
        messageId,
        status: 'sent',
      });

      // Also record in chat history (non-blocking to avoid timing issues)
      recordBroadcastInChat({
        broadcast,
        template,
        phoneNumber: to,
        contactId,
        messageId,
        contactResolvedText: hasDynamicVars
          ? resolveTemplateTextForContact(templateDoc, perContactComponents)
          : resolvedTemplateText,
        resolvedTemplateComponents,
      }).catch(err => {
        logger.warn(`Failed to record broadcast in chat for ${to}: ${err.message}`);
      });

      // Update broadcast list member
      if (broadcast.broadcastListId) {
        BroadcastListMember.updateOne(
          { broadcastListId: broadcast.broadcastListId, phoneNumber: { $in: variants } },
          { status: 'sent' }
        ).catch(err => {
          logger.warn(`Failed to update broadcast list member for ${to}: ${err.message}`);
        });
      }

      // Return success result
      return {
        status: 'success',
        phoneNumber: to,
        contactId,
        messageId,
        perContactComponents,
        contactDoc,
        variants,
      };
    } catch (err) {
      // Return error result
      const isSkipped = err.name === 'SkipContactError';
      return {
        status: 'error',
        phoneNumber: to,
        contactId,
        isSkipped,
        error: err,
        errorCode: err.response?.data?.error?.code || (isSkipped ? 403 : 500),
        errorMessage: err.response?.data?.error?.message || err.message,
        variants,
      };
    }
  }, phonesToSend, 5); // 5 concurrent API calls respects rate limits

  // Process results - just count outcomes (records already saved in concurrent loop)
  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const result of messageResults) {
    if (result.status === 'success') {
      sentCount++;
    } else {
      if (result.isSkipped) {
        skippedCount++;
        // Save skipped message
        BroadcastMessage.create({
          broadcastId: broadcast._id,
          contactId: result.contactId,
          phoneNumber: result.phoneNumber,
          status: 'skipped',
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        }).catch(err => {
          logger.warn(`Failed to save skipped message for ${result.phoneNumber}: ${err.message}`);
        });

        if (broadcast.broadcastListId && result.variants) {
          BroadcastListMember.updateOne(
            { broadcastListId: broadcast.broadcastListId, phoneNumber: { $in: result.variants } },
            { status: 'opted_out' }
          ).catch(err => {
            logger.warn(`Failed to update opted-out member: ${err.message}`);
          });
        }
      } else {
        failedCount++;
        // Save failed message
        BroadcastMessage.create({
          broadcastId: broadcast._id,
          contactId: result.contactId,
          phoneNumber: result.phoneNumber,
          status: 'failed',
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        }).catch(err => {
          logger.warn(`Failed to save failed message for ${result.phoneNumber}: ${err.message}`);
        });

        if (broadcast.broadcastListId && result.variants) {
          BroadcastListMember.updateOne(
            { broadcastListId: broadcast.broadcastListId, phoneNumber: { $in: result.variants } },
            { status: 'failed' }
          ).catch(err => {
            logger.warn(`Failed to update failed member: ${err.message}`);
          });
        }
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

  // Update batch stats with accurate counts
  await BroadcastBatch.findByIdAndUpdate(batchId, {
    status: 'completed',
    completedAt: new Date(),
    sentCount,
    failedCount,
    skippedCount,
    processedCount: sentCount + failedCount + skippedCount,
  });

  // Update broadcast statistics
  const allBatchMessages = await BroadcastMessage.countDocuments({ broadcastId: broadcast._id, status: 'sent' });
  const allBatchFailed = await BroadcastMessage.countDocuments({ broadcastId: broadcast._id, status: 'failed' });
  const allBatchSkipped = await BroadcastMessage.countDocuments({ broadcastId: broadcast._id, status: 'skipped' });
  const totalRecipients = await BroadcastMessage.countDocuments({ broadcastId: broadcast._id });
  const totalProcessed = allBatchMessages + allBatchFailed + allBatchSkipped;

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
    'statistics.processed': totalProcessed,
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
  recordBroadcastInChat,
};
