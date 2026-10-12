'use strict';

/** WhatsApp calling (SIP/Asterisk) settings, read from the backend .env. */
const path = require('path');

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

function load(env = process.env) {
  return {
    enabled: String(env.CALLING_ENABLED || 'false').toLowerCase() === 'true',
    // Shared secret for the private Asterisk -> backend HTTP calls (same value in deploy/asterisk/.env)
    internalSecret: env.CALLING_INTERNAL_SECRET || '',
    // Business phone number ids that are SIP-enabled at Meta and wired to Asterisk
    phoneNumberIds: list(env.CALLING_PHONE_NUMBER_IDS),
    sipDomain: env.SIP_DOMAIN || 'lk.biswakarmagold.com',
    wssUrl: env.SIP_WSS_URL || `wss://${env.SIP_DOMAIN || 'lk.biswakarmagold.com'}/ws`,
    iceServers: env.SIP_ICE_SERVERS ? JSON.parse(env.SIP_ICE_SERVERS) : [],
    generatedDir: env.ASTERISK_GENERATED_DIR || '/var/lib/bjs-calls/asterisk',
    asteriskUid: int(env.ASTERISK_UID, 2000),
    recordingsDir: path.resolve(env.CALL_RECORDINGS_DIR || '/var/lib/bjs-calls/recordings'),
    ami: {
      host: env.ASTERISK_AMI_HOST || '127.0.0.1',
      port: int(env.ASTERISK_AMI_PORT, 5038),
      username: env.ASTERISK_AMI_USER || 'bjsbackend',
      secret: env.ASTERISK_AMI_SECRET || '',
    },
    ringFirstSeconds: int(env.CALL_RING_FIRST_SECONDS, 25),
    ringAllSeconds: int(env.CALL_RING_ALL_SECONDS, 25),
    missedMessageCooldownMin: int(env.CALL_MISSED_MESSAGE_COOLDOWN_MIN, 30),
    recordingRetentionDays: int(env.CALL_RETENTION_DAYS, 365),
    missedMessageText: env.CALL_MISSED_MESSAGE_TEXT
      || 'Sorry, we were unable to pick up your call. One of our team will message you back shortly. You can also call us again on WhatsApp using the button below.',
  };
}

let cached;
const get = () => (cached ||= load());
const reset = () => { cached = undefined; };

module.exports = { load, get, reset };
