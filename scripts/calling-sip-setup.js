/**
 * WhatsApp Calling over SIP: setup / rollback helper for ONE business phone number.
 * Uses the WABA access token stored in MongoDB. Tokens are never printed.
 *
 *   node scripts/calling-sip-setup.js status            --phone <PHONE_NUMBER_ID>   (read-only)
 *   node scripts/calling-sip-setup.js enable            --phone <PHONE_NUMBER_ID> --host lk.biswakarmagold.com
 *        -> calling ENABLED, call button HIDDEN from customers (DISABLE_ALL), SDES media,
 *           SIP ENABLED to <host>:5061, SIP call webhooks OFF (backend untouched in Phase 1)
 *   node scripts/calling-sip-setup.js password          --phone <PHONE_NUMBER_ID>   (prints Meta's SIP password)
 *   node scripts/calling-sip-setup.js send-call-button  --phone <PHONE_NUMBER_ID> --to 91XXXXXXXXXX
 *        -> sends a "Call us on WhatsApp" button (tester must have messaged the number in the last 24 h)
 *   node scripts/calling-sip-setup.js request-permission --phone <PHONE_NUMBER_ID> --to 91XXXXXXXXXX
 *        -> asks the tester for permission to receive calls from the business
 *   node scripts/calling-sip-setup.js disable           --phone <PHONE_NUMBER_ID>
 *        -> ROLLBACK: calling DISABLED and SIP DISABLED (number returns to today's state)
 */
require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');
const Waba = require('../src/models/Waba');
const config = require('../src/config');
const { connectDB } = require('../src/config/database');

const BASE = `https://graph.facebook.com/${config.meta.apiVersion}`;
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => { const i = args.indexOf(`--${name}`); return i > -1 ? args[i + 1] : undefined; };

const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };
const call = async (method, path, token, data, params) => {
  try {
    const r = await axios({ method, url: `${BASE}${path}`, data, params, timeout: 20000, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    return r.data;
  } catch (e) {
    const err = e.response?.data?.error;
    fail(err ? `${err.message} (code ${err.code}${err.error_subcode ? `/${err.error_subcode}` : ''})${err.error_data ? ` ${JSON.stringify(err.error_data)}` : ''}` : e.message);
  }
};
const redact = (settings) => JSON.parse(JSON.stringify(settings, (k, v) => (k === 'sip_user_password' ? '***hidden***' : v)));

(async () => {
  const phoneId = opt('phone');
  if (!cmd || !phoneId) fail('usage: node scripts/calling-sip-setup.js <status|enable|password|send-call-button|request-permission|disable> --phone <PHONE_NUMBER_ID> [--host <sip host>] [--to <number>]');

  await connectDB();
  const waba = await Waba.findOne({ 'phoneNumbers.phoneNumberId': phoneId });
  if (!waba) fail(`no WABA in the database has phone number id ${phoneId}`);
  const token = waba.accessToken;
  const phone = waba.phoneNumbers.find((p) => p.phoneNumberId === phoneId);
  console.log(`WABA ${waba.wabaId} (${waba.businessName}) phone ${phone.phoneNumber} id ${phoneId}`);

  const showStatus = async () => {
    const s = await call('get', `/${phoneId}/settings`, token);
    console.log('calling settings:', JSON.stringify(redact(s.calling ?? s), null, 2));
  };

  switch (cmd) {
    case 'status':
      await showStatus();
      break;

    case 'enable': {
      const host = opt('host');
      if (!host) fail('--host is required, e.g. --host lk.biswakarmagold.com');
      const body = {
        calling: {
          status: 'ENABLED',
          call_icon_visibility: 'DISABLE_ALL',
          srtp_key_exchange_protocol: 'SDES',
          sip: { status: 'ENABLED', webhook_delivery: 'DISABLED', servers: [{ hostname: host, port: 5061 }] },
        },
      };
      console.log('POST settings:', JSON.stringify(body));
      console.log('result:', JSON.stringify(await call('post', `/${phoneId}/settings`, token, body)));
      await showStatus();
      console.log('\nNext: node scripts/calling-sip-setup.js password --phone', phoneId);
      break;
    }

    case 'password': {
      const s = await call('get', `/${phoneId}/settings`, token, undefined, { include_sip_credentials: true });
      const servers = s.calling?.sip?.servers || [];
      if (!servers.length) fail('no SIP server configured yet (run enable first)');
      for (const sv of servers) console.log(`app ${sv.app_id} host ${sv.hostname}  META_SIP_PASSWORD=${sv.sip_user_password}`);
      console.log('\nPut this value in the Asterisk .env file only. Do not paste it into chat or commit it.');
      break;
    }

    case 'send-call-button':
    case 'request-permission': {
      const to = (opt('to') || '').replace(/\D/g, '');
      if (!/^\d{10,15}$/.test(to)) fail('--to must be the tester number with country code, digits only');
      const interactive = cmd === 'send-call-button'
        ? { type: 'voice_call', body: { text: 'Test: tap below to call Biswakarma Jewellery Shilpalaya on WhatsApp.' }, action: { name: 'voice_call', parameters: { display_text: 'Call on WhatsApp', ttl_minutes: 1440 } } }
        : { type: 'call_permission_request', body: { text: 'Test: allow Biswakarma Jewellery Shilpalaya to call you on WhatsApp.' }, action: { name: 'call_permission_request' } };
      const r = await call('post', `/${phoneId}/messages`, token, { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive });
      console.log('sent:', JSON.stringify(r));
      break;
    }

    case 'disable': {
      const body = { calling: { status: 'DISABLED', sip: { status: 'DISABLED' } } };
      console.log('POST settings:', JSON.stringify(body));
      console.log('result:', JSON.stringify(await call('post', `/${phoneId}/settings`, token, body)));
      await showStatus();
      break;
    }

    default:
      fail(`unknown command ${cmd}`);
  }
  await mongoose.disconnect();
})().catch((e) => fail(e.message));
