/**
 * Why did customers who replied to a broadcast show as "Unassigned"?
 *
 * READ-ONLY: it only reads the database and prints a report. Nothing is changed.
 *
 * Usage (on the server, from whats-app-backend/, same .env as the running backend):
 *   node scripts/diagnose-broadcast-assignment.js              # most recent broadcast
 *   node scripts/diagnose-broadcast-assignment.js <broadcastId>
 *   node scripts/diagnose-broadcast-assignment.js <broadcastId> --all   # also list every replier
 *
 * Phone numbers are printed masked (last 4 digits only).
 *
 * For every recipient who wrote back after the broadcast it reports, for the chat the reply landed in
 * (the chat of the broadcast's WhatsApp account):
 *   - whether that chat existed BEFORE the broadcast or was CREATED by it
 *   - who it is assigned to now (and whether that user still exists / is active)
 *   - its assignment history (ChatActivity: assigned / unassigned / transferred)
 *   - whether the SAME customer has a chat on ANOTHER WhatsApp account (WABA) and who owns that one
 *   - whether the list stored the number without the country code (creates a second chat/contact)
 *   - whether the customer is tagged "monthly"
 * and groups the repliers by cause.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const { Broadcast, BroadcastMessage, Chat, Message, User, Waba, ChatActivity, Contact } = require(path.join(__dirname, '..', 'src', 'models'));
const { getMonthlyTagId } = require(path.join(__dirname, '..', 'src', 'utils', 'tag'));
const { normalizePhone } = require(path.join(__dirname, '..', 'src', 'utils', 'waIdentity'));

const mask = (p) => (p ? `…${String(p).slice(-4)}` : '-');
const iso = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '-');

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/whatsapp-system';
  await mongoose.connect(uri);
  const args = process.argv.slice(2);
  const listAll = args.includes('--all');
  const id = args.find((a) => !a.startsWith('--'));

  const broadcast = id ? await Broadcast.findById(id).lean() : await Broadcast.findOne().sort({ createdAt: -1 }).lean();
  if (!broadcast) { console.log('No broadcast found.'); return; }
  const start = broadcast.startedAt || broadcast.createdAt;
  const wabas = new Map((await Waba.find().select('businessName wabaId').lean()).map((w) => [String(w._id), w.businessName || w.wabaId]));
  console.log(`\nBroadcast "${broadcast.name}" (${broadcast._id})`);
  console.log(`  WhatsApp account: ${wabas.get(String(broadcast.wabaId)) || broadcast.wabaId}   status: ${broadcast.status}   started: ${iso(start)}`);
  console.log(`  WhatsApp accounts in the system: ${[...wabas.values()].join(', ')}`);

  const monthlyTagId = await getMonthlyTagId();
  const users = new Map((await User.find().select('name role isActive assignedWabaId').lean()).map((u) => [String(u._id), u]));

  const recipients = await BroadcastMessage.find({ broadcastId: broadcast._id, status: { $in: ['sent', 'delivered', 'read'] } }).select('phoneNumber').lean();
  console.log(`  Recipients sent: ${recipients.length}`);

  const buckets = {};
  const add = (key, row) => { (buckets[key] = buckets[key] || []).push(row); };
  const rows = [];
  let repliers = 0;

  for (const r of recipients) {
    const stored = String(r.phoneNumber || '').replace(/\D/g, '');
    const digits = normalizePhone(stored) || stored;
    if (!digits) continue;
    // Old broadcasts may have used the bare number: look in both the full-number and the bare-number chat.
    const chat = await Chat.findOne({ wabaId: broadcast.wabaId, waId: { $in: [...new Set([digits, stored])] }, mergedInto: null }).sort({ updatedAt: -1 }).lean();
    if (!chat) continue;
    const reply = await Message.findOne({ chatId: chat._id, direction: 'inbound', createdAt: { $gte: start } }).sort({ createdAt: 1 }).select('createdAt').lean();
    if (!reply) continue;
    repliers++;

    const last10 = digits.slice(-10);
    const others = await Chat.find({ _id: { $ne: chat._id }, mergedInto: null, waId: { $regex: `${last10}$` } }).select('wabaId waId assignedTo createdAt').lean();
    const acts = await ChatActivity.find({ chatId: chat._id, type: { $in: ['assigned', 'unassigned', 'transferred', 'auto_transferred'] } }).sort({ createdAt: 1 }).lean();
    const contact = chat.contactId ? await Contact.findById(chat.contactId).select('tags').lean() : null;
    const isMonthlyCustomer = !!monthlyTagId && [...(chat.tags || []), ...(contact?.tags || [])].some((t) => String(t) === monthlyTagId);

    const assignee = chat.assignedTo ? users.get(String(chat.assignedTo)) : null;
    const createdByBroadcast = chat.createdAt >= new Date(start.getTime() - 60e3);
    const ownedElsewhere = others.filter((o) => o.assignedTo);
    const shortNumber = stored.length <= 10;

    const row = {
      phone: mask(digits), created: createdByBroadcast ? 'by this broadcast' : `before (${iso(chat.createdAt)})`,
      reply: iso(reply.createdAt),
      assignedNow: chat.assignedTo ? (assignee ? `${assignee.name} (${assignee.role}${assignee.isActive === false ? ', INACTIVE' : ''})` : `DELETED USER ${chat.assignedTo}`) : 'nobody',
      history: acts.map((a) => `${iso(a.createdAt)} ${a.type}${a.details?.reason ? `(${a.details.reason})` : ''}`).join(' | ') || 'none',
      otherChats: others.map((o) => `${wabas.get(String(o.wabaId)) || o.wabaId}${o.waId !== digits ? ` as ${mask(o.waId)}(${o.waId.length} digits)` : ''}: ${o.assignedTo ? (users.get(String(o.assignedTo))?.name || 'deleted user') : 'unassigned'}`).join(' ; ') || 'none',
      monthly: isMonthlyCustomer,
    };
    rows.push(row);

    if (isMonthlyCustomer) add('M  Tagged "monthly" (left unassigned on purpose by the existing rules)', row);
    else if (chat.assignedTo && !assignee) add('D  Assigned to a user that was DELETED (apps show "Unassigned")', row);
    else if (chat.assignedTo && assignee) add('OK Assigned in the database now (if it looked unassigned, it was a display/refresh issue or it was assigned after the reply)', row);
    else if (ownedElsewhere.length && createdByBroadcast) add('W  Customer is assigned on ANOTHER WhatsApp account; this broadcast created a NEW, unassigned chat on its own account', row);
    else if (ownedElsewhere.length) add('W2 Customer is assigned on ANOTHER WhatsApp account; the chat on the broadcast account was never assigned', row);
    else if (acts.some((a) => a.type === 'unassigned')) add('U  Was assigned, then someone UNASSIGNED it manually', row);
    else if (createdByBroadcast) add('N  No chat existed before: the broadcast created it and the reply was not a "new chat", so it was never auto-assigned (fixed by the new rule)', row);
    else add('E  Chat existed before but was NEVER assigned (old rule only assigned brand-new chats; fixed by the new rule)', row);
    if (shortNumber) add('P  Number stored WITHOUT country code in the list (makes a second contact/chat)', row);
  }

  console.log(`  Recipients who replied: ${repliers}\n`);
  const keys = Object.keys(buckets).sort();
  if (!keys.length) console.log('No replies found for this broadcast.');
  for (const k of keys) {
    console.log(`${k}: ${buckets[k].length}`);
    for (const row of buckets[k].slice(0, listAll ? undefined : 5)) {
      console.log(`    ${row.phone}  chat created ${row.created}; replied ${row.reply}; assigned now: ${row.assignedNow}`);
      console.log(`        history: ${row.history}`);
      console.log(`        other chats of this customer: ${row.otherChats}`);
    }
    if (!listAll && buckets[k].length > 5) console.log(`    … ${buckets[k].length - 5} more (use --all)`);
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => mongoose.disconnect());
