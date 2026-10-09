/**
 * WhatsApp Error Classification Service
 * 
 * Classifies WhatsApp API errors into actionable categories:
 * - RETRYABLE_TRANSIENT: Temporary issues, safe to retry with backoff
 * - RETRYABLE_THROTTLED: Rate limiting/restrictions, retry with longer delays
 * - NON_RETRYABLE: Permanent failures, don't waste API quota
 * - INVESTIGATE: Requires manual investigation or system configuration fix
 * 
 * Based on Meta WhatsApp API error codes and documented behavior
 */

const ERROR_CLASSIFICATIONS = {
  // ========================================
  // TRANSIENT ERRORS (Safe to retry after short delay)
  // ========================================
  130472: {
    classification: 'RETRYABLE_TRANSIENT',
    title: 'Resource Unavailable',
    description: 'WhatsApp service temporarily unavailable or overloaded',
    category: 'Server Issue',
    recommendation: 'Retry after 2-5 minutes',
    maxRetries: 3,
    retryDelayMs: [5000, 10000, 30000], // 5s, 10s, 30s delays
    severity: 'medium',
    action: 'AUTO_RETRY',
  },

  // ========================================
  // THROTTLING/RATE LIMITING ERRORS (Requires backoff)
  // ========================================
  131048: {
    classification: 'RETRYABLE_THROTTLED',
    title: 'Phone Quality Issue / Rate Limited',
    description: 'Sending phone number has quality issues or hitting rate limits. WhatsApp throttling your account.',
    category: 'Phone Quality',
    recommendation: 'Reduce sending rate, check phone quality status in WhatsApp Manager',
    maxRetries: 1, // Only retry once after long delay
    retryDelayMs: [3600000], // 1 hour delay
    severity: 'high',
    action: 'THROTTLE_AND_RETRY',
    preventiveMeasure: 'Reduce BATCH_SIZE from 10 to 5, increase delays between batches',
  },

  131049: {
    classification: 'RETRYABLE_THROTTLED',
    title: 'Marketing Delivery Restriction',
    description: 'Your account has marketing message restrictions. Do not retry marketing messages immediately.',
    category: 'Account Restriction',
    recommendation: 'Check if this is a marketing window issue. Retry non-marketing messages only.',
    maxRetries: 0, // DO NOT AUTO-RETRY
    retryDelayMs: [], // No automatic retry
    severity: 'critical',
    action: 'MANUAL_REVIEW',
    preventiveMeasure: 'Contact WhatsApp Support to review account status',
  },

  // ========================================
  // INVALID RECIPIENT / DELIVERY FAILURES (Don't retry)
  // ========================================
  131026: {
    classification: 'NON_RETRYABLE',
    title: 'Message Undeliverable',
    description: 'Recipient number is invalid, not on WhatsApp, or cannot receive messages',
    category: 'Recipient Invalid',
    recommendation: 'Remove from recipient list. Validate phone numbers.',
    maxRetries: 0,
    retryDelayMs: [],
    severity: 'low',
    action: 'REMOVE_RECIPIENT',
  },

  130472: {
    classification: 'NON_RETRYABLE',
    title: 'Recipient Delivery Failure',
    description: 'Recipient cannot receive messages (blocked, opted-out, or account issues)',
    category: 'Recipient Unavailable',
    recommendation: 'Check recipient status. Verify number is on WhatsApp.',
    maxRetries: 0,
    retryDelayMs: [],
    severity: 'low',
    action: 'REMOVE_RECIPIENT',
  },

  // ========================================
  // INVALID PARAMETERS / TEMPLATE ISSUES (Requires investigation)
  // ========================================
  131009: {
    classification: 'INVESTIGATE',
    title: 'Invalid Parameter',
    description: 'Template variable mismatch or invalid parameter passed to API',
    category: 'Configuration Issue',
    recommendation: 'Review template components and variable mapping',
    maxRetries: 0,
    retryDelayMs: [],
    severity: 'high',
    action: 'INVESTIGATE_TEMPLATE',
  },

  131000: {
    classification: 'INVESTIGATE',
    title: 'Unsupported Message Type',
    description: 'Message type or action is not supported',
    category: 'Configuration Issue',
    recommendation: 'Check template format and message type',
    maxRetries: 0,
    retryDelayMs: [],
    severity: 'high',
    action: 'INVESTIGATE_TEMPLATE',
  },

  135000: {
    classification: 'INVESTIGATE',
    title: 'Unknown Error',
    description: 'Unknown WhatsApp error. Requires investigation.',
    category: 'Unknown',
    recommendation: 'Check WhatsApp API documentation and logs',
    maxRetries: 1,
    retryDelayMs: [30000],
    severity: 'medium',
    action: 'INVESTIGATE',
  },

  100: {
    classification: 'INVESTIGATE',
    title: 'Generic Error',
    description: 'Generic error from WhatsApp API. Often API misconfiguration.',
    category: 'API Issue',
    recommendation: 'Check API credentials, rate limits, and request format',
    maxRetries: 0,
    retryDelayMs: [],
    severity: 'high',
    action: 'INVESTIGATE_API',
  },

  2: {
    classification: 'INVESTIGATE',
    title: 'Parse Error',
    description: 'Request parsing error. Usually malformed request.',
    category: 'Request Format',
    recommendation: 'Check request payload format',
    maxRetries: 0,
    retryDelayMs: [],
    severity: 'high',
    action: 'INVESTIGATE_REQUEST',
  },
};

/**
 * Get classification for an error code
 */
function classifyError(errorCode, errorMessage = '') {
  const classification = ERROR_CLASSIFICATIONS[errorCode];
  
  if (classification) {
    return {
      errorCode,
      ...classification,
      originalMessage: errorMessage,
    };
  }

  // Default classification for unknown errors
  return {
    errorCode,
    classification: 'INVESTIGATE',
    title: 'Unknown WhatsApp Error',
    description: `WhatsApp error code ${errorCode}: ${errorMessage}`,
    category: 'Unknown',
    recommendation: 'Contact WhatsApp Support with error details',
    maxRetries: 0,
    retryDelayMs: [],
    severity: 'medium',
    action: 'INVESTIGATE',
    originalMessage: errorMessage,
  };
}

/**
 * Check if an error is retryable
 */
function isRetryable(errorCode) {
  const classification = classifyError(errorCode);
  return classification.classification.startsWith('RETRYABLE');
}

/**
 * Check if retry should be automated or manual
 */
function isAutoRetryable(errorCode) {
  const classification = classifyError(errorCode);
  return classification.action === 'AUTO_RETRY' && classification.maxRetries > 0;
}

/**
 * Get retry configuration for an error
 */
function getRetryConfig(errorCode) {
  const classification = classifyError(errorCode);
  return {
    maxRetries: classification.maxRetries,
    delayMs: classification.retryDelayMs,
    backoffMultiplier: classification.classification === 'RETRYABLE_THROTTLED' ? 2 : 1,
  };
}

/**
 * Group failed messages by error classification for reporting
 */
function groupByClassification(failedMessages) {
  const grouped = {
    RETRYABLE_TRANSIENT: [],
    RETRYABLE_THROTTLED: [],
    NON_RETRYABLE: [],
    INVESTIGATE: [],
  };

  for (const msg of failedMessages) {
    const classification = classifyError(msg.errorCode, msg.errorMessage);
    grouped[classification.classification].push({
      ...msg,
      classification,
    });
  }

  return grouped;
}

/**
 * Generate summary report of error breakdown
 */
function generateErrorSummary(failedMessages) {
  const grouped = groupByClassification(failedMessages);
  
  return {
    total: failedMessages.length,
    byClassification: {
      retryableTransient: grouped.RETRYABLE_TRANSIENT.length,
      retryableThrottled: grouped.RETRYABLE_THROTTLED.length,
      nonRetryable: grouped.NON_RETRYABLE.length,
      investigate: grouped.INVESTIGATE.length,
    },
    byErrorCode: failedMessages.reduce((acc, msg) => {
      acc[msg.errorCode] = (acc[msg.errorCode] || 0) + 1;
      return acc;
    }, {}),
    recommendations: {
      immediate: grouped.RETRYABLE_TRANSIENT.length > 0 
        ? `Retry ${grouped.RETRYABLE_TRANSIENT.length} transient failures`
        : 'No transient failures',
      throttled: grouped.RETRYABLE_THROTTLED.length > 0
        ? `⚠️ CRITICAL: ${grouped.RETRYABLE_THROTTLED.length} messages throttled. Reduce sending rate.`
        : 'No throttling detected',
      nonRetryable: grouped.NON_RETRYABLE.length > 0
        ? `Remove ${grouped.NON_RETRYABLE.length} invalid recipients`
        : 'No invalid recipients',
      investigate: grouped.INVESTIGATE.length > 0
        ? `⚠️ Investigate ${grouped.INVESTIGATE.length} configuration issues`
        : 'No investigation needed',
    },
  };
}

module.exports = {
  ERROR_CLASSIFICATIONS,
  classifyError,
  isRetryable,
  isAutoRetryable,
  getRetryConfig,
  groupByClassification,
  generateErrorSummary,
};
