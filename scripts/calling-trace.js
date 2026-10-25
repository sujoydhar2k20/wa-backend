/**
 * READ-ONLY timeline of recent inbound WhatsApp calls, to see exactly where an answered call fails.
 * Changes nothing (no writes to the database, Asterisk or Meta). Prints no tokens or passwords.
 *
 *   node scripts/calling-trace.js                 # last 5 inbound calls
 *   node scripts/calling-trace.js --last 10
 *   node scripts/calling-trace.js --id <callLogId>
 *
 * For every call it prints, in time order and in seconds from the start of the call:
 *   - our CallLog (ring stage, who answered, when, how it ended, Meta's final status and error codes)
 *   - every Meta "calls" webhook for that call (call_created / terminate + error codes)
 *   - every step the Android app / web panel reported (invite_received, answered, connected, failed ...)
 *   - the Asterisk log lines for that call's time window (who was rung, who answered, who hung up first)
 */
require('dotenv').config();
const fs = require('fs');
const { execSync } = require('child_process');
const mongoose = require('mongoose');
const { connectDB } = require('../src/config/database');
const { CallLog, CallEvent, User } = require('../src/models');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : undefined; };
const last = Math.min(Math.max(parseInt(opt('last') || '5', 10) || 5, 1), 30);
const onlyId = opt('id');
const ASTERISK_LOG = process.env.ASTERISK_LOG_FILE || '/var/log/bjs-asterisk/messages.log';

const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim(); } catch (_) { return null; } };
const off = (t, t0) => (t && t0 ? `${((new Date(t) - new Date(t0)) / 1000).toFixed(1).padStart(6)}s` : '     ?s');
const hide = (s) => String(s || '').replace(/\+?\d{10,15}/g, (m) => `${m.slice(0, 4)}…${m.slice(-3)}`);

function asteriskLines(from, to) {
  let text = null;
  try { text = fs.readFileSync(ASTERISK_LOG, 'utf8'); } catch (_) {
    text = sh(`sudo -n tail -n 20000 ${ASTERISK_LOG}`);
  }
  if (!text) return [`(could not read ${ASTERISK_LOG}; run with sudo, or: sudo grep '${from.toISOString().slice(0, 16).replace('T', ' ')}' ${ASTERISK_LOG})`];
  const a = from.getTime() - 2000;
  const b = to.getTime() + 3000;
  const out = [];
  for (const l of text.split('\n')) {
    const m = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/.exec(l);
    if (!m) continue;
    const t = new Date(`${m[1]}Z`).getTime(); // Asterisk container logs in UTC
    const tl = new Date(m[1]).getTime();      // ...or in server local time
    if ((t >= a && t <= b) || (tl >= a && tl <= b)) {
      if (/Called|answered|is ringing|Hungup|hangup|Dial|WA-|stage-all|ANSWER|NOANSWER|CANCEL|BYE|408|480|487|Spawn extension|Executing \[.*(Dial|Hangup|Log|CURL)/i.test(l)) out.push(hide(l));
    }
  }
  return out.length ? out.slice(0, 120) : ['(no Asterisk lines found in that time window)'];
}

(async () => {
  await connectDB();
  const q = onlyId ? { _id: onlyId } : { direction: 'inbound' };
  const calls = await CallLog.find(q).sort({ createdAt: -1 }).limit(onlyId ? 1 : last).lean();
  const userIds = new Set();
  calls.forEach((c) => { (c.ringTargets || []).forEach((u) => userIds.add(String(u))); if (c.answeredBy) userIds.add(String(c.answeredBy)); });
  const users = await User.find({ _id: { $in: [...userIds] } }).select('name role').lean();
  const name = (id) => { const u = users.find((x) => String(x._id) === String(id)); return u ? `${u.name} (${u.role})` : String(id || '-'); };

  const running = sh('docker exec bjs-asterisk asterisk -rx "dialplan show from-whatsapp"') || '';
  console.log(`\nRunning Asterisk dialplan: ${running ? `${running.includes('stage-all') ? 'has' : 'MISSING'} stage-all step, ${/app-wait/.test(sh('docker exec bjs-asterisk asterisk -rx "dialplan show app-wait"') || '') ? 'has' : 'MISSING'} app-wait step` : 'could not read (docker exec not allowed for this user?)'}`);

  for (const c of calls.reverse()) {
    const t0 = c.startedAt || c.createdAt;
    const plan = c.metadata?.plan || {};
    console.log(`\n================ call ${c._id}  ${new Date(t0).toISOString()}  customer ${hide(`+${c.waId}`)}`);
    console.log(`  result: ${c.status}  endReason=${c.endReason || '-'}  stage=${c.stage}  answered ${c.answeredAt ? off(c.answeredAt, t0).trim() : 'never'} by ${c.answeredBy ? name(c.answeredBy) : '-'} on ${c.answeredDevice || '-'}  talk=${c.duration || 0}s`);
    console.log(`  ring plan: stage1=[${(plan.first || []).map(name).join(', ') || 'none'}]  stage2=${(plan.all || []).length} users  declinedBy=[${(c.metadata?.declinedBy || []).map(name).join(', ')}]`);
    console.log(`  Meta final view: status=${c.meta?.status || '-'} duration=${c.meta?.duration ?? '-'} errors=${JSON.stringify(c.meta?.errors || [])}`);
    const evs = await CallEvent.find({ $or: [{ callLogId: c._id }, ...(c.callId ? [{ wacid: c.callId }] : [])] }).sort({ at: 1 }).lean();
    const timeline = [
      { at: t0, line: 'call reached Asterisk (CallLog created)' },
      ...(c.answeredAt ? [{ at: c.answeredAt, line: `Asterisk reported ANSWER by ${name(c.answeredBy)} (${c.answeredDevice || '-'})` }] : []),
      ...(c.endedAt ? [{ at: c.endedAt, line: `Asterisk reported HANGUP (${c.endReason || '-'})` }] : []),
      ...evs.map((e) => ({
        at: e.at,
        line: e.source === 'meta'
          ? `META ${e.event} status=${e.status || '-'}${(e.errorList || []).length ? ` errors=${e.errorList.map((x) => `${x.code}${x.meaning ? ` ${x.meaning}` : x.title ? ` ${x.title}` : ''}`).join('; ')}` : ''}`
          : `CLIENT ${e.device || '-'} ${name(e.userId)}: ${e.event}${e.detail ? ` ${e.detail}` : ''}`,
      })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at));
    for (const x of timeline) console.log(`  ${off(x.at, t0)}  ${x.line}`);
    const end = c.endedAt || new Date(new Date(t0).getTime() + 70000);
    console.log('  --- Asterisk log for this call window ---');
    for (const l of asteriskLines(new Date(t0), new Date(end))) console.log(`    ${l}`);
  }
  await mongoose.disconnect();
})().catch(async (e) => { console.error(e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
