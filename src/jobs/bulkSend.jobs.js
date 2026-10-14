const { logger } = require('../utils/logger');
const { addressOf } = require('../utils/waIdentity');

/**
 * Background job: processes bulk product image sends to WhatsApp sequentially
 * with rate-limit-safe delays (pacing unchanged). Each file goes through the shared media pipeline
 * (same preparation rules as normal sends: pass-through when acceptable), is uploaded to Meta, then sent.
 * Stage + status updates are persisted on the message and emitted via socket.
 */
module.exports = function (agenda) {
  agenda.define('send-bulk-messages', async (job) => {
    const { chatId, messageIds } = job.attrs.data;
    const { Message, Chat } = require('../models');
    const { getIO } = require('../websocket/socket.server');

    const chat = await Chat.findById(chatId).populate('contactId', 'isBlocked isOptedOut');
    if (!chat) {
      logger.error(`[BulkSend] Chat ${chatId} not found, aborting job`);
      return;
    }

    // Block sending to blocked or opted-out contacts
    if (chat.contactId && (chat.contactId.isBlocked || chat.contactId.isOptedOut)) {
      const reason = chat.contactId.isBlocked ? 'blocked' : 'opted-out';
      logger.info(`[BulkSend] Chat ${chatId} contact is ${reason}, marking all messages as failed`);

      for (const msgId of messageIds) {
        const message = await Message.findById(msgId);
        if (message && message.status === 'queued') {
          message.status = 'failed';
          message.errorMessage = `Cannot send messages to ${reason} contacts.`;
          await message.save();

          getIO().emit('message:status', {
            chatId: chat._id.toString(),
            messageId: message._id.toString(),
            status: 'failed',
            errorMessage: message.errorMessage
          });
        }
      }
      return;
    }

    logger.info(`[BulkSend] Starting bulk send of ${messageIds.length} messages for chat ${chatId}`);

    for (let i = 0; i < messageIds.length; i++) {
      const msgId = messageIds[i];
      const message = await Message.findById(msgId);
      if (!message) {
        logger.warn(`[BulkSend] Message ${msgId} not found, skipping`);
        continue;
      }

      // Skip if already processed (e.g. job re-run)
      if (message.status !== 'queued') {
        logger.info(`[BulkSend] Message ${msgId} already has status '${message.status}', skipping`);
        continue;
      }
      // A re-run after a crash must never send a message twice: one that reached the send step
      // without a confirmed result is left to the webhook / recovery sweep.
      if (['sending', 'unconfirmed', 'sent'].includes(message.pipeline?.stage)) {
        logger.warn(`[BulkSend] Message ${msgId} was already at '${message.pipeline.stage}', not re-sending`);
        continue;
      }

      try {
        await sendOneBulkMessage(message, chat);
      } catch (err) {
        logger.error(`[BulkSend] Failed to send message ${msgId}: ${err.message}`);
        await markFailed(message, err);
      }

      // Rate limiting delay between sends: 1.5s for first 5, 2.5s after
      if (i < messageIds.length - 1) {
        const delay = i < 5 ? 1500 : 2500;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    logger.info(`[BulkSend] Completed bulk send for chat ${chatId}`);
  });
};

const iso = () => new Date().toISOString();

function emit(message) {
  try {
    require('../services/media/mediaMessageService').emitPipeline(message);
  } catch (e) {
    logger.warn(`[BulkSend] socket emit failed: ${e.message}`);
  }
}

/** Same preparation, Meta upload and safe-send rules as normal sends (services/media/mediaPipeline). */
async function sendOneBulkMessage(message, chat) {
  const media = require('../services/media/mediaPipeline');
  const { Message } = require('../models');
  const timings = { ...(message.pipeline?.timings || {}), prepareStartedAt: iso() };
  message.pipeline = { ...(message.pipeline || {}), mode: 'bulk', stage: 'preparing', active: false, version: (message.pipeline?.version || 0) + 1, timings };
  message.markModified('pipeline');
  await message.save();
  emit(message);

  let mediaIdToSend = message.mediaUrl;
  let prepared;
  if (message.mediaUrl && message.mediaUrl.startsWith('http')) {
    try {
      prepared = await media.prepareMedia({ type: message.type, mediaUrl: message.mediaUrl });
      const up = await media.uploadToMeta(chat, prepared.file);
      mediaIdToSend = up.mediaId;
      Object.assign(timings, {
        prepareEndedAt: iso(), sourceMs: prepared.timings.sourceMs, sourceLocal: prepared.timings.sourceLocal,
        prepareMs: prepared.timings.prepareMs, inputBytes: prepared.details.inputBytes, outputBytes: prepared.file.size,
        metaUploadMs: up.ms, metaUploadedAt: iso(),
      });
      message.pipeline.prepareAction = prepared.action;
    } finally {
      if (prepared) await prepared.cleanup();
    }
  }
  timings.sendStartedAt = iso();
  message.pipeline = { ...message.pipeline, stage: 'sending', stageAt: new Date(), version: message.pipeline.version + 1, timings };
  message.markModified('pipeline');
  await message.save();
  emit(message);
  const result = await media.sendOnce({
    chat, to: addressOf(chat), type: message.type, mediaIdOrUrl: mediaIdToSend, caption: message.caption || '',
    bizOpaque: `bjs:${message._id}:${(message.pipeline.sendAttempts || 0) + 1}`,
  });
  timings.sendMs = result.ms;
  message.pipeline.sendAttempts = (message.pipeline.sendAttempts || 0) + 1;
  if (result.ok) {
    timings.sentAt = iso();
    // Re-read: a fast webhook may already have moved the status forward.
    const fresh = await Message.findById(message._id);
    fresh.messageId = fresh.messageId || result.wamid;
    if (['queued', 'failed'].includes(fresh.status)) fresh.status = 'sent';
    fresh.errorCode = undefined;
    fresh.errorMessage = undefined;
    fresh.pipeline = { ...message.pipeline, stage: 'sent', version: message.pipeline.version + 1, timings, error: null };
    fresh.markModified('pipeline');
    await fresh.save();
    emit(fresh);
    logger.info(`[BulkSend] Message ${message._id} sent (${result.wamid})`);
    return;
  }
  if (result.kind === 'ambiguous') {
    // Never re-sent automatically: the recovery sweep marks it failed if no webhook confirms it.
    message.pipeline = {
      ...message.pipeline, stage: 'unconfirmed', stageAt: new Date(), version: message.pipeline.version + 1,
      timings: { ...timings, unconfirmedAt: iso() },
      error: { stage: 'send', message: 'WhatsApp did not confirm the send. Checking...', at: iso(), willRetry: false },
    };
    message.markModified('pipeline');
    await message.save();
    emit(message);
    return;
  }
  throw result.error;
}

async function markFailed(message, err) {
  message.status = 'failed';
  message.errorMessage = String(err?.message || 'Send failed').slice(0, 300);
  if (err?.metaCode != null) message.errorCode = err.metaCode;
  message.pipeline = {
    ...(message.pipeline || {}), mode: 'bulk', stage: 'failed', active: false,
    version: (message.pipeline?.version || 0) + 1,
    timings: { ...(message.pipeline?.timings || {}), failedAt: iso() },
    error: { stage: 'send', message: message.errorMessage, at: iso(), willRetry: false },
  };
  message.markModified('pipeline');
  await message.save();
  emit(message);
}
