'use strict';

/** Small AES-256-GCM helper for storing SIP passwords (key derived from CALLING_SIP_KEY or JWT_SECRET). */
const crypto = require('crypto');

function key() {
  const base = process.env.CALLING_SIP_KEY || process.env.JWT_SECRET;
  if (!base) throw new Error('CALLING_SIP_KEY or JWT_SECRET must be set');
  return crypto.createHash('sha256').update(`bjs-sip-v1:${base}`).digest();
}

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

function open(sealed) {
  const [v, iv, tag, enc] = String(sealed || '').split(':');
  if (v !== 'v1') throw new Error('unknown sealed format');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

module.exports = { seal, open };
