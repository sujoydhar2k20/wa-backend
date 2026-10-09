/**
 * Bounded Retry Job Service
 * 
 * Safely retries failed broadcast messages based on error classification
 * - Only retries messages marked as retryable
 * - Respects max retry limits
 * - Tracks retry history and attempts
 * - Implements backoff delays
 * - Prevents wasting API quota on non-retryable errors
 */

const { BroadcastMessage, Broadcast, BroadcastBatch } = require('../models');
const { logger } = require('../utils/logger');
const errorClassifier = require('./whatsapp-error-classifier.service');

/**
 * Get all messages that are ready to retry (scheduled time has passed)
 */
async function getMessagesReadyForRetry() {
    try {
        const now = new Date();
        const messagesReadyForRetry = await BroadcastMessage.find({
            status: 'failed',
            nextRetryAt: { $lte: now },
            $expr: { $lt: ['$retryAttempts', '$maxRetryAttempts'] }, // retryAttempts < maxRetryAttempts
        }).select('_id broadcastId phoneNumber errorCode errorMessage retryAttempts nextRetryAt');

        logger.info(`[BOUNDED RETRY] Found ${messagesReadyForRetry.length} messages ready for retry`);
        return messagesReadyForRetry;
    } catch (err) {
        logger.error('[BOUNDED RETRY] Error fetching retry-ready messages:', err);
        return [];
    }
}

/**
 * Process retries for a set of messages
 * Groups them by broadcast and creates retry batches
 */
async function processRetries(messages, maxConcurrency = 5) {
    if (messages.length === 0) {
        logger.info('[BOUNDED RETRY] No messages to retry');
        return { processed: 0, successful: 0, failed: 0, errors: [] };
    }

    // Group by broadcast
    const messagesByBroadcast = {};
    for (const msg of messages) {
        if (!messagesByBroadcast[msg.broadcastId]) {
            messagesByBroadcast[msg.broadcastId] = [];
        }
        messagesByBroadcast[msg.broadcastId].push(msg);
    }

    let successful = 0;
    let failed = 0;
    const errors = [];

    // Process each broadcast
    for (const [broadcastId, broadcastMessages] of Object.entries(messagesByBroadcast)) {
        try {
            logger.info(`[BOUNDED RETRY] Processing ${broadcastMessages.length} retries for broadcast ${broadcastId}`);
            
            // Process messages in batches
            for (let i = 0; i < broadcastMessages.length; i += maxConcurrency) {
                const batch = broadcastMessages.slice(i, i + maxConcurrency);
                
                const results = await Promise.all(
                    batch.map(msg => retryMessage(msg))
                );
                
                for (const result of results) {
                    if (result.success) {
                        successful++;
                    } else {
                        failed++;
                        errors.push(result.error);
                    }
                }
            }
        } catch (err) {
            logger.error(`[BOUNDED RETRY] Error processing broadcast ${broadcastId}:`, err);
            errors.push(`Broadcast ${broadcastId}: ${err.message}`);
            failed += broadcastMessages.length;
        }
    }

    return {
        processed: messages.length,
        successful,
        failed,
        errors,
    };
}

/**
 * Retry a single failed message
 * Updates retry history and schedules next retry if applicable
 */
async function retryMessage(message) {
    try {
        const retryConfig = errorClassifier.getRetryConfig(message.errorCode);
        const nextAttempt = message.retryAttempts + 1;

        if (nextAttempt > retryConfig.maxRetries) {
            logger.warn(`[BOUNDED RETRY] Message ${message._id} exceeded max retries (${nextAttempt}/${retryConfig.maxRetries})`);
            return {
                success: false,
                error: `Message ${message._id} exceeded max retry attempts`,
            };
        }

        const update = {
            retryAttempts: nextAttempt,
            lastRetryAt: new Date(),
        };

        // Schedule next retry if there's another attempt allowed
        if (nextAttempt < retryConfig.maxRetries && nextAttempt < retryConfig.delayMs.length) {
            const delayMs = retryConfig.delayMs[nextAttempt];
            const nextRetryTime = new Date();
            nextRetryTime.setMilliseconds(nextRetryTime.getMilliseconds() + delayMs);
            update.nextRetryAt = nextRetryTime;
            logger.info(`[BOUNDED RETRY] Message ${message._id} scheduled for retry at ${nextRetryTime.toISOString()}`);
        } else {
            update.nextRetryAt = null;
            logger.info(`[BOUNDED RETRY] Message ${message._id} has no more retries scheduled`);
        }

        // Track retry history
        const historyEntry = {
            attemptNumber: nextAttempt,
            retriedAt: new Date(),
            result: 'pending', // Will be updated when webhook comes in
            errorCode: message.errorCode,
            errorMessage: message.errorMessage,
        };

        update.$push = { retryHistory: historyEntry };

        await BroadcastMessage.findByIdAndUpdate(message._id, update);
        
        logger.info(`[BOUNDED RETRY] Retry attempt ${nextAttempt} for message ${message._id}`);
        return { success: true };
    } catch (err) {
        logger.error(`[BOUNDED RETRY] Error retrying message ${message._id}:`, err);
        return {
            success: false,
            error: `Failed to retry message ${message._id}: ${err.message}`,
        };
    }
}

/**
 * Check if there are active throttling restrictions
 * Returns true if any messages have RETRYABLE_THROTTLED classification
 */
async function hasActiveThrottling(broadcastId) {
    try {
        const throttledCount = await BroadcastMessage.countDocuments({
            broadcastId,
            status: 'failed',
            errorClassification: 'RETRYABLE_THROTTLED',
        });
        return throttledCount > 0;
    } catch (err) {
        logger.error('[BOUNDED RETRY] Error checking throttling status:', err);
        return false;
    }
}

/**
 * Get recommended batch size based on current error conditions
 * Reduces concurrency if throttling is detected
 */
async function getRecommendedBatchSize(broadcastId, defaultBatchSize = 10) {
    const isThrottled = await hasActiveThrottling(broadcastId);
    
    if (isThrottled) {
        logger.warn(`[BOUNDED RETRY] Throttling detected for broadcast ${broadcastId}. Reducing batch size.`);
        return Math.max(1, Math.floor(defaultBatchSize / 2)); // Reduce by 50%
    }
    
    return defaultBatchSize;
}

/**
 * Clean up messages that have exceeded retry limits
 * Useful for reporting and preventing future retry attempts
 */
async function cleanupExhaustedRetries() {
    try {
        const exhaustedMessages = await BroadcastMessage.find({
            status: 'failed',
            $expr: { $gte: ['$retryAttempts', '$maxRetryAttempts'] },
            maxRetryAttempts: { $gt: 0 },
        }).select('_id errorCode retryAttempts maxRetryAttempts');

        if (exhaustedMessages.length > 0) {
            // Mark for manual review
            await BroadcastMessage.updateMany(
                {
                    _id: { $in: exhaustedMessages.map(m => m._id) },
                },
                {
                    $set: { nextRetryAt: null }
                }
            );

            logger.info(`[BOUNDED RETRY] Marked ${exhaustedMessages.length} messages as exhausted retries`);
        }
    } catch (err) {
        logger.error('[BOUNDED RETRY] Error cleaning up exhausted retries:', err);
    }
}

module.exports = {
    getMessagesReadyForRetry,
    processRetries,
    retryMessage,
    hasActiveThrottling,
    getRecommendedBatchSize,
    cleanupExhaustedRetries,
};
