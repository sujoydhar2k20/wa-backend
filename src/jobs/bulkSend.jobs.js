const { logger } = require('../utils/logger');

/**
 * Background job: processes bulk product image sends to WhatsApp sequentially
 * with rate-limit-safe delays. Each image is downloaded, converted to JPEG,
 * uploaded to Meta, then sent. Status updates are emitted via socket in real-time.
 */
module.exports = function (agenda) {
  agenda.define('send-bulk-messages', async (job) => {
    const { chatId, messageIds } = job.attrs.data;
    const { Message, Chat } = require('../models');
    const whatsappService = require('../services/whatsapp.service');
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

      try {
        const type = message.type;
        const mediaUrl = message.mediaUrl;
        let mediaIdToSend = mediaUrl;

        // Download, convert, and upload to Meta
        if (mediaUrl && mediaUrl.startsWith('http')) {
          const axios = require('axios');
          const response = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WhatsApp-Bot/1.0)' }
          });
          let buffer = Buffer.from(response.data, 'binary');
          let mimeType = response.headers['content-type'] || 'image/jpeg';
          mimeType = mimeType.split(';')[0].trim();

          // Always convert images to JPEG for WhatsApp compatibility
          if (type === 'image') {
            const sharp = require('sharp');
            buffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
            mimeType = 'image/jpeg';
          }

          // Upload to Meta with retry
          mediaIdToSend = await retryWithBackoff(
            () => whatsappService.uploadMedia(chat.wabaId, chat.phoneNumberId, buffer, mimeType)
          );
        }

        // Send via WhatsApp API with retry
        const waResult = await retryWithBackoff(
          () => whatsappService.sendMediaMessage(
            chat.wabaId, chat.phoneNumberId, chat.waId,
            type, mediaIdToSend, message.caption || ''
          )
        );

        // Update message in DB with WhatsApp message ID and 'sent' status
        const waMsgId = waResult?.messages?.[0]?.id;
        message.messageId = waMsgId;
        message.status = 'sent';
        await message.save();

        // Emit status update via socket so frontend updates in real-time
        getIO().emit('message:status', {
          chatId: chat._id.toString(),
          messageId: message._id.toString(),
          waMessageId: waMsgId,
          status: 'sent'
        });

        logger.info(`[BulkSend] Message ${i + 1}/${messageIds.length} sent successfully (${waMsgId})`);
      } catch (err) {
        logger.error(`[BulkSend] Failed to send message ${msgId}: ${err.message}`);

        // Mark as failed in DB
        message.status = 'failed';
        message.errorMessage = err.message;
        await message.save();

        // Emit failure status
        getIO().emit('message:status', {
          chatId: chat._id.toString(),
          messageId: message._id.toString(),
          status: 'failed',
          errorMessage: err.message
        });
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

/**
 * Retry a function with exponential backoff (same logic as messages.controller).
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 1500) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const isRetryable = status === 429 || (status >= 500 && status < 600) || !status;
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn(`[BulkSend] API call failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
