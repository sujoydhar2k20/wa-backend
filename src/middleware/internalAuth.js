'use strict';

/**
 * Guards the private Asterisk -> backend endpoints (/internal/calls/*):
 *  - shared secret in X-Internal-Secret (CALLING_INTERNAL_SECRET, same value in deploy/asterisk/.env)
 *  - request must come straight from this machine (loopback) and not through nginx (no X-Forwarded-For)
 */
const crypto = require('crypto');
const callingConfig = require('../services/calls/config');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function internalAuth(req, res, next) {
  const secret = callingConfig.get().internalSecret;
  const given = String(req.get('x-internal-secret') || '');
  const okSecret = secret.length >= 32 && given.length === secret.length
    && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  const remote = req.socket?.remoteAddress || '';
  const viaProxy = !!(req.get('x-forwarded-for') || req.get('x-real-ip') || req.get('forwarded'));
  if (!okSecret || !LOOPBACK.has(remote) || viaProxy) return res.status(404).type('text/plain').send('Not found');
  next();
}

module.exports = { internalAuth };
