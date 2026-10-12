/**
 * READ-ONLY diagnosis of "Couldn't place call - <business> is unable to receive WhatsApp calls".
 * Checks everything Meta looks at before it lets a customer call, plus our side of the path,
 * and shows what happened to recent call attempts. Never prints tokens or the SIP password.
 *
 *   node scripts/calling-diagnose.js --phone 1244660898719753 [--hours 24]
 *
 * Reading the result:
 *   - attempts with "no call reached our server" + an error code -> Meta refused it (see meaning)
 *   - attempts that reached Asterisk but no staff answered        -> our routing/devices (see Calls page)
 *   - customers on WhatsApp Desktop/Web/tablet cannot call businesses at all (Meta limitation)
 */
require('dotenv').config();
const axios = require('axios');
const { execSync } = require('child_process');
const mongoose = require('mongoose');
const config = require('../src/config');
const { connectDB } = require('../src/config/database');
const { Waba, CallLog, CallEvent, User } = require('../src/models');
const { meaningOf } = require('../src/services/calls/metaErrors');

const BASE = `https://graph.facebook.com/${config.meta.apiVersion}`;
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : undefined; };
const phoneId = opt('phone');
const hours = Math.min(Math.max(parseInt(opt('hours') || '24', 10) || 24, 1), 24 * 30);

const OK = 'OK  ';
const BAD = 'FAIL';
const WARN = 'WARN';
const line = (tag, text) => console.log(`  [${tag}] ${text}`);

async function get(path, token, params) {
  try {
    const r = await axios.get(`${BASE}${path}`, { params, timeout: 20000, headers: { Authorization: `Bearer ${token}` } });
    return { data: r.data };
  } catch (e) {
    const err = e.response?.data?.error;
    return { error: err ? `${err.message} (code ${err.code}${err.error_subcode ? `/${err.error_subcode}` : ''})` : e.message };
  }
}

/** Try a field list; if Meta rejects one field, retry the fields one by one and keep what works. */
async function getFields(path, token, fields) {
  const all = await get(path, token, { fields: fields.join(',') });
  if (!all.error) return all.data;
  const out = {};
  for (const f of fields) {
    const r = await get(path, token, { fields: f });
    if (!r.error && r.data[f] !== undefined) out[f] = r.data[f];
  }
  return out;
}

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim(); } catch (e) { return null; }
}

function openNow(callHours) {
  if (!callHours || callHours.status !== 'ENABLED') return { open: true, why: 'call hours disabled (open 24/7)' };
  const tz = callHours.timezone_id || 'Asia/Kolkata';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  const day = parts.weekday.toUpperCase();
  const hhmm = `${parts.hour}${parts.minute}`;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const holiday = (callHours.holiday_schedule || []).find((h) => h.date === date);
  if (holiday) {
    const inHol = hhmm >= String(holiday.start_time) && hhmm < String(holiday.end_time);
    if (inHol) return { open: false, why: `holiday ${date} ${holiday.start_time}-${holiday.end_time} (${tz})` };
  }
  const slots = (callHours.weekly_operating_hours || []).filter((w) => w.day_of_week === day);
  const open = slots.some((w) => hhmm >= String(w.open_time) && hhmm < String(w.close_time));
  return { open, why: `${day} ${hhmm} ${tz}; today's hours: ${slots.map((w) => `${w.open_time}-${w.close_time}`).join(', ') || 'closed all day'}` };
}

(async () => {
  if (!phoneId) { console.error('usage: node scripts/calling-diagnose.js --phone <PHONE_NUMBER_ID> [--hours 24]'); process.exit(1); }
  await connectDB();
  const waba = await Waba.findOne({ 'phoneNumbers.phoneNumberId': phoneId });
  if (!waba) { console.error(`no WABA in the database has phone number id ${phoneId}`); process.exit(1); }
  const token = waba.accessToken;
  const phone = waba.phoneNumbers.find((p) => p.phoneNumberId === phoneId);
  console.log(`\nWhatsApp calling diagnosis  ${new Date().toISOString()}`);
  console.log(`WABA ${waba.wabaId} (${waba.businessName})  number ${phone.phoneNumber}  id ${phoneId}\n`);

  // 1. Meta: calling settings
  console.log('1. Calling settings at Meta');
  const s = await get(`/${phoneId}/settings`, token);
  const c = s.data?.calling || {};
  if (s.error) line(BAD, `cannot read settings: ${s.error}`);
  else {
    line(c.status === 'ENABLED' ? OK : BAD, `calling: ${c.status || '(not set)'}`);
    line(c.sip?.status === 'ENABLED' ? OK : BAD, `SIP: ${c.sip?.status || '(not set)'} -> ${(c.sip?.servers || []).map((v) => `${v.hostname}:${v.port || 5061}`).join(', ') || 'no server'}`);
    line(c.call_icon_visibility === 'DEFAULT' ? OK : WARN, `call button for customers: ${c.call_icon_visibility || '(not set)'}${c.call_icon_visibility === 'DISABLE_ALL' ? ' (hidden: customers can only call through call buttons you send)' : ''}`);
    if (c.call_icons?.restrict_to_user_countries?.length) line(WARN, `call button limited to countries: ${c.call_icons.restrict_to_user_countries.join(',')} (other countries see "unable to receive")`);
    const oh = openNow(c.call_hours);
    line(oh.open ? OK : WARN, `call hours: ${oh.open ? 'OPEN now' : 'CLOSED now (customers see "unable to receive")'} - ${oh.why}`);
    line(c.sip?.webhook_delivery === 'ENABLED' ? OK : WARN, `SIP call webhooks: ${c.sip?.webhook_delivery || '(not set)'}${c.sip?.webhook_delivery !== 'ENABLED' ? ' (turn on to see why Meta refuses calls: calling-sip-setup.js sip-webhooks on)' : ''}`);
  }

  // 2. Meta: number + account health (payment method, limits, quality)
  console.log('\n2. Number and account health at Meta');
  const ph = await getFields(`/${phoneId}`, token, ['display_phone_number', 'verified_name', 'status', 'quality_rating', 'messaging_limit_tier', 'name_status', 'platform_type', 'health_status']);
  line(ph.status && ph.status !== 'CONNECTED' ? WARN : OK, `number status: ${ph.status || '?'}, platform: ${ph.platform_type || '?'}, name: ${ph.name_status || '?'}`);
  line(ph.quality_rating === 'RED' ? BAD : OK, `quality: ${ph.quality_rating || '?'}  messaging limit: ${ph.messaging_limit_tier || '?'}`);
  const wb = await getFields(`/${waba.wabaId}`, token, ['name', 'account_review_status', 'primary_funding_id', 'health_status', 'currency']);
  line(wb.primary_funding_id ? OK : BAD, `payment method on the WhatsApp Business Account: ${wb.primary_funding_id ? 'present' : 'NOT FOUND (Meta error 131044 refuses customer calls - add one in WhatsApp Manager > Payment methods)'}`);
  if (wb.account_review_status) line(wb.account_review_status === 'APPROVED' ? OK : WARN, `account review: ${wb.account_review_status}`);
  for (const [label, hs] of [['number', ph.health_status], ['account', wb.health_status]]) {
    if (!hs) continue;
    line(hs.can_send_message === 'AVAILABLE' ? OK : WARN, `${label} health: ${hs.can_send_message || '?'}`);
    for (const ent of hs.entities || []) {
      for (const er of ent.errors || []) line(BAD, `  ${ent.entity_type}: ${er.error_code} ${er.error_description || ''}${er.possible_solution ? ` -> ${er.possible_solution}` : ''}`);
    }
  }

  // 3. Our server
  console.log('\n3. Our calling server');
  const sipDomain = process.env.SIP_DOMAIN || (c.sip?.servers || [])[0]?.hostname;
  if (sipDomain) {
    const cert = sh(`echo | openssl s_client -connect ${sipDomain}:5061 -servername ${sipDomain} 2>/dev/null | openssl x509 -noout -enddate -subject`);
    if (!cert) line(BAD, `cannot open TLS to ${sipDomain}:5061 from this server (Meta cannot either)`);
    else {
      const end = new Date((cert.match(/notAfter=(.*)/) || [])[1]);
      const days = Math.round((end - Date.now()) / 86400e3);
      line(days > 14 ? OK : days > 0 ? WARN : BAD, `TLS ${sipDomain}:5061 certificate valid ${days} more days (until ${end.toISOString().slice(0, 10)})`);
    }
  }
  const ast = sh('docker exec bjs-asterisk asterisk -rx "core show uptime seconds"');
  line(ast ? OK : BAD, ast ? `Asterisk running (${ast.replace(/\n/g, ', ')})` : 'Asterisk container not running or not reachable');
  if (ast) {
    const appWait = sh('docker exec bjs-asterisk asterisk -rx "dialplan show app-wait"');
    line(appWait && /app-wait/.test(appWait) ? OK : BAD, appWait && /app-wait/.test(appWait) ? 'Android "wait for the phone" step loaded' : 'Android app ringing step NOT loaded: run docker compose up -d --force-recreate in deploy/asterisk');
    const contacts = sh('docker exec bjs-asterisk asterisk -rx "pjsip show contacts"') || '';
    const online = (contacts.match(/Contact:\s+u[0-9a-f]{24}(-app)?\//g) || []).length;
    line(online ? OK : WARN, `staff devices online right now: ${online} (web tabs + open Android apps; closed apps are woken by push)`);
    const meta = sh('docker exec bjs-asterisk asterisk -rx "pjsip show endpoint whatsapp"') || '';
    line(/Unavailable/.test(meta) ? WARN : OK, `Meta SIP endpoint: ${/Unavailable/.test(meta) ? 'Unavailable (qualify failing?)' : 'configured'}`);
  }
  const androidUsers = await User.countDocuments({ isActive: true, 'sip.androidAppAt': { $gt: new Date(Date.now() - 90 * 86400e3) } });
  line(OK, `staff with the Android app (last 90 days): ${androidUsers}`);

  // 4. Recent attempts
  console.log(`\n4. Customer call attempts, last ${hours} h`);
  const since = new Date(Date.now() - hours * 3600e3);
  const logs = await CallLog.find({ direction: 'inbound', phoneNumberId: phoneId, createdAt: { $gt: since } }).sort({ createdAt: -1 }).limit(40).lean();
  const events = await CallEvent.find({ source: 'meta', at: { $gt: since }, $or: [{ phoneNumberId: phoneId }, { phoneNumberId: null }] }).sort({ at: -1 }).limit(200).lean();
  const metaFails = events.filter((e) => (e.errorList || []).length || String(e.status || '').toUpperCase() === 'FAILED');
  if (!events.length) line(WARN, 'no Meta call webhooks stored in this period (are SIP call webhooks ON? see section 1)');
  const byWacid = new Map(events.filter((e) => e.wacid).map((e) => [e.wacid, e]));
  const counts = { answered: 0, missed: 0, failedAtWhatsApp: 0 };
  for (const l of logs) {
    const failed = l.metadata?.failedAtMeta;
    const res = failed ? 'FAILED AT WHATSAPP' : l.answeredAt ? 'answered' : 'missed';
    counts[failed ? 'failedAtWhatsApp' : l.answeredAt ? 'answered' : 'missed'] += 1;
    const err = (l.meta?.errors || [])[0];
    const when = new Date(l.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    console.log(`    ${when}  +${l.waId}  ${res}${l.endReason ? ` (${l.endReason})` : ''}${err ? `  meta ${err.code}: ${err.meaning || err.message || ''}` : ''}`);
  }
  console.log(`    -> ${counts.answered} answered, ${counts.missed} missed (reached our staff), ${counts.failedAtWhatsApp} refused by WhatsApp before reaching us`);
  const uniqueCodes = {};
  for (const e of metaFails) for (const er of e.errorList || []) uniqueCodes[er.code] = (uniqueCodes[er.code] || 0) + 1;
  for (const [code, n] of Object.entries(uniqueCodes)) line(BAD, `Meta error ${code} x${n}: ${meaningOf(code) || 'see Meta calling error codes'}`);

  console.log('\nNotes');
  console.log('  - WhatsApp Desktop, WhatsApp Web and tablets cannot call businesses (Meta supports Android and iPhone only).');
  console.log('    Those customers always see "unable to receive WhatsApp calls"; nothing reaches our server.');
  console.log('  - To trace one failed call: note the time, then:');
  console.log("      grep -E 'WA-INBOUND|WA-MISSED' /var/log/bjs-asterisk/messages.log | tail");
  console.log("      pm2 logs whats-backend --lines 500 --nostream | grep '\\[calls\\]\\[meta\\]'");
  await mongoose.disconnect();
})().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
