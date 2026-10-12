'use strict';

/**
 * Meta WhatsApp Calling error codes -> plain meaning (source: Meta "Calling API troubleshooting").
 * Used in logs, the diagnose script and call logs so a failed call says WHY it failed.
 */
const MEANINGS = {
  131044: 'No valid payment method on the WhatsApp Business Account (Meta refuses customer calls)',
  131055: 'Graph API call endpoints are not allowed for SIP-enabled numbers',
  138000: 'Calling is not enabled for this business number',
  138001: 'Customer cannot be called/call cannot be placed (not on WhatsApp, terms not accepted, or unsupported client such as WhatsApp Desktop/Web)',
  138003: 'A call is already ongoing with this customer',
  138006: 'No approved call permission from the customer',
  138009: 'Call permission request limit reached',
  138012: 'Daily business-initiated call limit reached',
  138013: 'Business-initiated calling is not available for this account',
  138014: 'Calling temporarily disabled by Meta because of low call quality',
  138015: 'Calling needs a messaging limit of at least 2000',
  138017: 'Customer already gave permanent call permission',
  138018: 'Calling prerequisites not met (SIP not configured or calls webhook not subscribed)',
};

function meaningOf(code) {
  return MEANINGS[Number(code)] || null;
}

/** Normalise Meta's errors (array or object, in call or value) to [{code,title,message,meaning}], sanitised. */
function normaliseErrors(...sources) {
  const out = [];
  for (const src of sources) {
    if (!src) continue;
    const list = Array.isArray(src) ? src : [src];
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      const code = Number(e.code ?? e.error_code);
      const msg = String(e.message || e.error_data?.details || e.details || '').slice(0, 300);
      out.push({
        code: Number.isFinite(code) ? code : undefined,
        title: String(e.title || '').slice(0, 120) || undefined,
        message: msg || undefined,
        meaning: meaningOf(code) || undefined,
      });
    }
  }
  return out;
}

module.exports = { MEANINGS, meaningOf, normaliseErrors };
