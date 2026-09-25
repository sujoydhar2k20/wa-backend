const crypto = require('crypto');
const config = require('../config');
const { logger } = require('../utils/logger');

/**
 * Verifies that an inbound webhook really comes from Meta.
 *
 * Meta signs the raw request body with the app secret (HMAC-SHA256) and sends it in the
 * `X-Hub-Signature-256: sha256=<hex>` header. We recompute the HMAC over the exact bytes
 * received (captured as req.rawBody in app.js) and compare in constant time.
 *
 * Fails closed: a missing secret, missing raw body, missing/malformed header or a mismatch
 * all result in 403 and the payload is never processed.
 *
 * Logging never includes the payload, the signature values or the secret - only the
 * reason, source IP, path and body size.
 */
function reject(req, reason) {
  logger.warn('Webhook signature verification failed', {
    reason,
    ip: req.ip,
    path: req.originalUrl ? req.originalUrl.split('?')[0] : req.path,
    contentLength: req.rawBody ? req.rawBody.length : 0,
  });
  return { status: 403, body: { success: false, message: 'Forbidden' } };
}

function verifyMetaSignature(req, res, next) {
  const secret = config.meta.appSecret;
  if (!secret) {
    logger.error('Webhook rejected: META_APP_SECRET is not configured');
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }

  const header = req.get('x-hub-signature-256');
  if (!header || !req.rawBody) {
    const r = reject(req, !header ? 'missing_signature_header' : 'missing_raw_body');
    return res.status(r.status).json(r.body);
  }

  const match = /^sha256=([a-f0-9]{64})$/i.exec(header.trim());
  if (!match) {
    const r = reject(req, 'malformed_signature_header');
    return res.status(r.status).json(r.body);
  }

  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest();
  const received = Buffer.from(match[1], 'hex');

  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    const r = reject(req, 'signature_mismatch');
    return res.status(r.status).json(r.body);
  }

  next();
}

module.exports = { verifyMetaSignature };
