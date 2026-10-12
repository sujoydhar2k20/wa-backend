/**
 * WhatsApp Calling over SIP: setup / rollback helper for ONE business phone number.
 * Uses the WABA access token stored in MongoDB. Tokens are never printed.
 *
 *   node scripts/calling-sip-setup.js status            --phone <PHONE_NUMBER_ID>   (read-only)
 *   node scripts/calling-sip-setup.js enable            --phone <PHONE_NUMBER_ID> --host lk.biswakarmagold.com
 *        -> calling ENABLED, call button HIDDEN from customers (DISABLE_ALL), SDES media,
 *           SIP ENABLED to <host>:5061, SIP call webhooks OFF (backend untouched in Phase 1)
 *   node scripts/calling-sip-setup.js password          --phone <PHONE_NUMBER_ID>   (writes Meta's current SIP password into deploy/asterisk/.env; never prints it)
 *   node scripts/calling-sip-setup.js send-call-button  --phone <PHONE_NUMBER_ID> --to 91XXXXXXXXXX
 *        -> sends a "Call us on WhatsApp" button (tester must have messaged the number in the last 24 h)
 *   node scripts/calling-sip-setup.js request-permission --phone <PHONE_NUMBER_ID> --to 91XXXXXXXXXX
 *        -> asks the tester for permission to receive calls from the business
 *   node scripts/calling-sip-setup.js disable           --phone <PHONE_NUMBER_ID>
 *        -> PAUSE/ROLLBACK: calling DISABLED and SIP DISABLED. The SIP server entry is kept on purpose,
 *           so the SIP password does NOT change. Use rotate-sip-password to get a new password.
 *   node scripts/calling-sip-setup.js rotate-sip-password --phone <PHONE_NUMBER_ID> --host lk.biswakarmagold.com [--yes]
 *        -> Meta's documented password reset: disable calling + SIP and clear the server list, re-enable
 *           (SDES, call button hidden, callback permission and other settings preserved), fetch the NEW
 *           password and write it straight into deploy/asterisk/.env (never printed), then verify.
 *           Without --yes it only shows what it would do.
 *   node scripts/calling-sip-setup.js sip-webhooks on|off --phone <PHONE_NUMBER_ID>
 *        -> turn Meta's SIP call webhooks (call_created / terminate) on or off. Changes nothing else;
 *           verifies afterwards that the SIP server and password are unchanged.
 */
require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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
const fingerprint = (v) => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 8);
// Writes META_SIP_PASSWORD into the Asterisk .env (mode 600) without printing it.
function writeSipPasswordToEnv(envFile, pw) {
  if (/[\s;#"'\\]/.test(pw)) console.warn('    WARNING: the password contains a space or one of ; # " \' \\ which needs escaping in Asterisk/.env. Tell Claude before starting Asterisk.');
  if (!fs.existsSync(envFile)) {
    const alt = path.join(path.dirname(envFile), '.meta-sip-password');
    fs.writeFileSync(alt, `META_SIP_PASSWORD=${pw}\n`, { mode: 0o600 });
    fs.chmodSync(alt, 0o600);
    return `${envFile} does not exist yet; password saved to ${alt} (mode 600). Copy that line into .env, then delete the file.`;
  }
  let envText = fs.readFileSync(envFile, 'utf8');
  envText = /^META_SIP_PASSWORD=.*$/m.test(envText)
    ? envText.replace(/^META_SIP_PASSWORD=.*$/m, () => `META_SIP_PASSWORD=${pw}`)
    : `${envText.replace(/\n?$/, '\n')}META_SIP_PASSWORD=${pw}\n`;
  const tmp = `${envFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, envText, { mode: 0o600 });
  fs.renameSync(tmp, envFile);
  fs.chmodSync(envFile, 0o600);
  return `password written to ${envFile} (mode 600, fingerprint ${fingerprint(pw)})`;
}

(async () => {
  const phoneId = opt('phone');
  if (!cmd || !phoneId) fail('usage: node scripts/calling-sip-setup.js <status|enable|password|send-call-button|request-permission|disable|rotate-sip-password|sip-webhooks> --phone <PHONE_NUMBER_ID> [--host <sip host>] [--to <number>]');

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
      console.log('\nNext: node scripts/calling-sip-setup.js password --phone', phoneId, '(writes it into deploy/asterisk/.env)');
      break;
    }

    case 'password': {
      // Never prints the password: writes it into deploy/asterisk/.env (or --env-file) and shows a fingerprint.
      const envFile = path.resolve(opt('env-file') || path.join(__dirname, '../deploy/asterisk/.env'));
      const s = await call('get', `/${phoneId}/settings`, token, undefined, { include_sip_credentials: true });
      const servers = s.calling?.sip?.servers || [];
      if (servers.length !== 1) fail(`expected exactly 1 SIP server, found ${servers.length}: ${JSON.stringify(redact(servers))}`);
      if (!servers[0].sip_user_password) fail('Meta did not return a SIP password');
      console.log(`app ${servers[0].app_id} host ${servers[0].hostname}: ${writeSipPasswordToEnv(envFile, servers[0].sip_user_password)}`);
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

    case 'rotate-sip-password': {
      const host = opt('host');
      if (!host) fail('--host is required, e.g. --host lk.biswakarmagold.com');
      const envFile = path.resolve(opt('env-file') || path.join(__dirname, '../deploy/asterisk/.env'));
      const sha = (v) => crypto.createHash('sha256').update(String(v || '')).digest('hex');
      const getFull = async () => (await call('get', `/${phoneId}/settings`, token, undefined, { include_sip_credentials: true })).calling || {};
      const passwordsOf = (c) => (c.sip?.servers || []).map((sv) => sv.sip_user_password).filter(Boolean);
      // Settings we must keep as they were (compared before vs after).
      const KEEP = ['callback_permission_status', 'call_icons', 'call_hours', 'audio', 'voicemail'];
      const pick = (c) => Object.fromEntries(KEEP.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));

      // Step 0: snapshot
      const before = await getFull();
      const oldHashes = passwordsOf(before).map(sha);
      const keep = pick(before);
      console.log('\n[0] current settings (password hidden):', JSON.stringify(redact(before), null, 2));
      const plan = {
        step1: { calling: { status: 'DISABLED', sip: { status: 'DISABLED', servers: [] } } },
        step2: {
          calling: {
            status: 'ENABLED',
            call_icon_visibility: 'DISABLE_ALL',
            srtp_key_exchange_protocol: 'SDES',
            ...(keep.callback_permission_status ? { callback_permission_status: keep.callback_permission_status } : {}),
            sip: { status: 'ENABLED', webhook_delivery: before.sip?.webhook_delivery || 'DISABLED', servers: [{ hostname: host, port: 5061 }] },
          },
        },
      };
      console.log('\nPlan:\n  1) POST', JSON.stringify(plan.step1), '\n  2) POST', JSON.stringify(plan.step2));
      console.log(`  3) fetch the new password and write META_SIP_PASSWORD into ${envFile} (mode 600, never printed)`);
      console.log('  4) verify settings, and restore any of', KEEP.join(', '), 'that changed');
      if (!args.includes('--yes')) { console.log('\nDry run only. Re-run with --yes to perform the rotation.'); break; }

      // Step 1: disable + clear servers (Meta's documented reset)
      console.log('\n[1] disabling calling + SIP and clearing servers:', JSON.stringify(await call('post', `/${phoneId}/settings`, token, plan.step1)));
      const cleared = await getFull();
      if ((cleared.sip?.servers || []).length) {
        fail(`SIP servers still present after clearing: ${JSON.stringify(redact(cleared.sip.servers))}. They belong to another app and must be cleared with that app's token. Calling is currently DISABLED; re-run "enable" to restore.`);
      }
      console.log('    servers cleared, sip.status =', cleared.sip?.status, ', calling.status =', cleared.status);

      // Step 2: re-enable
      console.log('[2] re-enabling:', JSON.stringify(await call('post', `/${phoneId}/settings`, token, plan.step2)));

      // Step 3: new password -> .env
      let after = await getFull();
      const servers = after.sip?.servers || [];
      if (servers.length !== 1) fail(`expected exactly 1 SIP server after re-enable, found ${servers.length}: ${JSON.stringify(redact(servers))}`);
      const newPw = servers[0].sip_user_password;
      if (!newPw) fail('Meta did not return a SIP password (check app permission whatsapp_business_management)');
      if (oldHashes.includes(sha(newPw))) fail('Meta returned the SAME password as before. Do not use it; contact Meta support or retry later.');

      console.log(`[3] New password: ${writeSipPasswordToEnv(envFile, newPw)}`);
      console.log('    The old password is no longer valid at Meta.');

      // Step 4: verify + restore preserved settings if Meta reset any of them
      const changed = KEEP.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (changed.length) {
        const restore = { calling: Object.fromEntries(changed.filter((k) => before[k] !== undefined).map((k) => [k, before[k]])) };
        if (Object.keys(restore.calling).length) {
          console.log('[4] restoring settings changed by the reset:', changed.join(', '));
          console.log('    result:', JSON.stringify(await call('post', `/${phoneId}/settings`, token, restore)));
          after = await getFull();
        }
      }
      const checks = [
        ['calling.status', after.status, 'ENABLED'],
        ['call_icon_visibility', after.call_icon_visibility, 'DISABLE_ALL'],
        ['srtp_key_exchange_protocol', after.srtp_key_exchange_protocol, 'SDES'],
        ['sip.status', after.sip?.status, 'ENABLED'],
        ['sip.servers', (after.sip?.servers || []).map((sv) => `${sv.hostname}${sv.port ? `:${sv.port}` : ''}`).join(','), `${host}`],
        ['password changed', !oldHashes.includes(sha(passwordsOf(after)[0])), true],
        ...KEEP.map((k) => [k, JSON.stringify(after[k]), JSON.stringify(before[k])]),
      ];
      console.log('\n[4] verification:');
      let ok = true;
      for (const [name, actual, expected] of checks) {
        // srtp_key_exchange_protocol is not always echoed back by Meta's GET; absent counts as "not reported".
        const pass = name === 'sip.servers' ? String(actual).startsWith(expected)
          : name === 'srtp_key_exchange_protocol' ? (actual === expected || actual === undefined)
          : actual === expected;
        if (!pass) ok = false;
        console.log(`    ${pass ? 'OK  ' : 'DIFF'} ${name}: ${actual ?? '(not set)'}${pass ? '' : `   expected ${expected ?? '(not set)'}`}`);
      }
      console.log(ok ? '\nRotation complete.' : '\nRotation done, but some values differ (see DIFF lines). Send these lines to Claude.');
      console.log('Next: cd deploy/asterisk && docker compose up -d --force-recreate   (Asterisk reads .env only when the container is created)');
      break;
    }

    case 'sip-webhooks': {
      const mode = String(args[1] || '').toLowerCase();
      if (!['on', 'off'].includes(mode)) fail('usage: sip-webhooks on|off --phone <PHONE_NUMBER_ID>');
      const sha = (v) => crypto.createHash('sha256').update(String(v || '')).digest('hex');
      const getFull = async () => (await call('get', `/${phoneId}/settings`, token, undefined, { include_sip_credentials: true })).calling || {};
      const before = await getFull();
      if (before.sip?.status !== 'ENABLED') fail('SIP is not enabled on this number');
      const pwBefore = (before.sip.servers || []).map((sv) => sha(sv.sip_user_password));
      const body = { calling: { sip: { webhook_delivery: mode === 'on' ? 'ENABLED' : 'DISABLED' } } };
      console.log('POST settings:', JSON.stringify(body));
      console.log('result:', JSON.stringify(await call('post', `/${phoneId}/settings`, token, body)));
      const after = await getFull();
      const pwAfter = (after.sip?.servers || []).map((sv) => sha(sv.sip_user_password));
      const same = JSON.stringify(pwBefore) === JSON.stringify(pwAfter);
      console.log(`sip.status=${after.sip?.status} webhook_delivery=${after.sip?.webhook_delivery ?? '(not reported)'} servers=${(after.sip?.servers || []).map((sv) => sv.hostname).join(',')}`);
      console.log(`SIP password unchanged: ${same ? 'YES' : 'NO'}`);
      if (!same) {
        const envFile = path.resolve(opt('env-file') || path.join(__dirname, '../deploy/asterisk/.env'));
        console.log(`Meta issued a new SIP password: ${writeSipPasswordToEnv(envFile, after.sip.servers[0].sip_user_password)}`);
        console.log('Apply it: cd deploy/asterisk && docker compose up -d --force-recreate');
      }
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
