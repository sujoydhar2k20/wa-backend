/**
 * Customer identity resolution for inbound webhooks: phone (wa_id) and/or business-scoped user ID (BSUID).
 *
 * Rules
 *  - A BSUID is never written to phone fields, and no phone number is ever invented.
 *  - One contact/chat per customer: lookups match EITHER identity; identities learned later are added
 *    to the existing record instead of creating another one.
 *  - If a customer already has two records (an old phone-only chat and a newer BSUID-only chat created
 *    while WhatsApp hid the phone), the first webhook that carries both identities folds the BSUID-only
 *    record into the phone record: messages are moved, nothing is deleted, and the folded record keeps
 *    `mergedInto` for audit.
 */
const { Contact, Chat, Message } = require('../models');
const { logger } = require('../utils/logger');
const { isBsuid, phoneDigits, identityFilter } = require('../utils/waIdentity');

/** Identity of the sender of an inbound message (webhook `messages[]` + `contacts[]`). */
function senderIdentity(msg = {}, contacts = []) {
  let waId = phoneDigits(msg.from);
  let bsuid = isBsuid(msg.from_user_id) ? msg.from_user_id : '';
  const entry = (contacts || []).find((c) => (waId && phoneDigits(c.wa_id) === waId) || (bsuid && c.user_id === bsuid))
    || ((contacts || []).length === 1 ? contacts[0] : undefined);
  if (entry) {
    if (!waId) waId = phoneDigits(entry.wa_id);
    if (!bsuid && isBsuid(entry.user_id)) bsuid = entry.user_id;
  }
  const parent = msg.from_parent_user_id || entry?.parent_user_id;
  return {
    waId,
    bsuid,
    parentBsuid: isBsuid(parent) ? parent : '',
    username: entry?.profile?.username ? String(entry.profile.username).slice(0, 100) : '',
    profileName: entry?.profile?.name ? String(entry.profile.name).slice(0, 200) : '',
  };
}

function short(identity) {
  return identity.waId ? `phone …${identity.waId.slice(-4)}` : `bsuid …${String(identity.bsuid).slice(-6)}`;
}

/** Find or create the Contact for an identity, adding newly learned identity fields. */
async function resolveContact(identity) {
  const filter = identityFilter(identity);
  if (!filter) throw new Error('Inbound message has no sender identity (no wa_id and no user_id)');
  const phoneOr = identity.waId ? [{ waId: identity.waId }, { phoneNumber: identity.waId }] : [];
  const query = { $or: [...phoneOr, ...(identity.bsuid ? [{ bsuid: identity.bsuid }] : [])], mergedInto: null };
  const found = await Contact.find(query).sort({ createdAt: 1 });

  const byPhone = identity.waId ? found.find((c) => c.waId === identity.waId || c.phoneNumber === identity.waId) : null;
  const byBsuid = identity.bsuid ? found.find((c) => c.bsuid === identity.bsuid) : null;
  let contact = byPhone || byBsuid || null;

  if (byPhone && byBsuid && String(byPhone._id) !== String(byBsuid._id)) {
    // Fold the BSUID-only contact into the phone contact (keep both documents).
    byBsuid.mergedInto = byPhone._id;
    const movedBsuid = byBsuid.bsuid;
    byBsuid.bsuid = undefined;
    if (movedBsuid) byBsuid.previousBsuids = [...new Set([...(byBsuid.previousBsuids || []), movedBsuid])];
    await byBsuid.save();
    if (byBsuid.isBlocked && !byPhone.isBlocked) { byPhone.isBlocked = true; byPhone.blockedAt = byBsuid.blockedAt || new Date(); }
    const tags = new Set([...(byPhone.tags || []), ...(byBsuid.tags || [])].map(String));
    byPhone.tags = [...tags];
    if (!byPhone.name && byBsuid.name) byPhone.name = byBsuid.name;
    logger.info(`[identity] merged contact ${byBsuid._id} into ${byPhone._id} (${short(identity)})`);
  }

  if (!contact) {
    const name = identity.profileName;
    contact = await Contact.create({
      phoneNumber: identity.waId || undefined,
      waId: identity.waId || undefined,
      bsuid: identity.bsuid || undefined,
      parentBsuid: identity.parentBsuid || undefined,
      username: identity.username || undefined,
      nameOnWhatsApp: name || undefined,
      name: name || '',
    });
    return contact;
  }

  let changed = false;
  const set = (k, v) => { if (v && contact[k] !== v) { contact[k] = v; changed = true; } };
  if (identity.waId) {
    if (!contact.waId) set('waId', identity.waId);
    if (!contact.phoneNumber) set('phoneNumber', identity.waId);
  }
  if (identity.bsuid && contact.bsuid !== identity.bsuid) {
    if (contact.bsuid) contact.previousBsuids = [...new Set([...(contact.previousBsuids || []), contact.bsuid])];
    set('bsuid', identity.bsuid);
  }
  set('parentBsuid', identity.parentBsuid);
  set('username', identity.username);
  if (identity.profileName) {
    set('nameOnWhatsApp', identity.profileName);
    if (!contact.name) set('name', identity.profileName);
  }
  if (changed || contact.isModified()) await contact.save();
  return contact;
}

/**
 * Find the chat for an identity on a WABA (null when none), adding newly learned identities and
 * folding a duplicate BSUID-only chat into the phone chat. Does not change the assignment of the
 * phone chat; it only inherits the other chat's staff member when it had none.
 */
async function resolveChat(wabaId, identity) {
  const filter = identityFilter(identity);
  if (!filter) return null;
  const found = await Chat.find({ wabaId, mergedInto: null, ...filter }).sort({ createdAt: 1 });
  const byPhone = identity.waId ? found.find((c) => c.waId === identity.waId) : null;
  const byBsuid = identity.bsuid ? found.find((c) => c.bsuid === identity.bsuid) : null;
  let chat = byPhone || byBsuid || null;
  if (!chat) return null;

  if (byPhone && byBsuid && String(byPhone._id) !== String(byBsuid._id)) {
    const moved = await Message.updateMany({ chatId: byBsuid._id }, { $set: { chatId: byPhone._id } });
    byBsuid.mergedInto = byPhone._id;
    byBsuid.bsuid = undefined;
    byBsuid.status = 'closed';
    byBsuid.closedAt = byBsuid.closedAt || new Date();
    await byBsuid.save();
    if (!byPhone.assignedTo && byBsuid.assignedTo) byPhone.assignedTo = byBsuid.assignedTo;
    const tags = new Set([...(byPhone.tags || []), ...(byBsuid.tags || [])].map(String));
    byPhone.tags = [...tags];
    logger.info(`[identity] merged chat ${byBsuid._id} into ${byPhone._id}: ${moved.modifiedCount} message(s) moved`);
    chat = byPhone;
  }

  if (identity.waId && !chat.waId) { chat.waId = identity.waId; chat.phoneNumber = identity.waId; }
  if (identity.waId && !chat.phoneNumber) chat.phoneNumber = identity.waId;
  if (identity.bsuid && chat.bsuid !== identity.bsuid) chat.bsuid = identity.bsuid;
  return chat; // caller saves
}

/**
 * A customer's BSUID changed (system message `user_changed_user_id`, or the `user_id_update` webhook).
 * Moves the new BSUID onto the existing contact/chats; keeps the old one in previousBsuids.
 */
async function applyUserIdChange({ previous, current, waId }) {
  if (!isBsuid(current)) return { contacts: 0, chats: 0 };
  const digits = phoneDigits(waId);
  const or = [];
  if (isBsuid(previous)) or.push({ bsuid: previous });
  if (digits) or.push({ waId: digits });
  if (!or.length) return { contacts: 0, chats: 0 };
  const contacts = await Contact.find({ $or: or, mergedInto: null });
  for (const c of contacts) {
    if (c.bsuid === current) continue;
    if (c.bsuid) c.previousBsuids = [...new Set([...(c.previousBsuids || []), c.bsuid])];
    c.bsuid = current;
    await c.save();
  }
  const chats = await Chat.find({ $or: or, mergedInto: null });
  let chatCount = 0;
  for (const ch of chats) {
    if (ch.bsuid === current) continue;
    // Never two chats with the same BSUID on a WABA (unique index): skip if one already has it.
    const clash = await Chat.exists({ wabaId: ch.wabaId, bsuid: current, _id: { $ne: ch._id } });
    if (clash) { logger.warn(`[identity] chat ${ch._id}: new user id already on another chat, not moved`); continue; }
    ch.bsuid = current;
    await ch.save();
    chatCount++;
  }
  logger.info(`[identity] user id changed (…${String(previous || '').slice(-6)} -> …${current.slice(-6)}): ${contacts.length} contact(s), ${chatCount} chat(s)`);
  return { contacts: contacts.length, chats: chatCount };
}

/** Webhook field `user_id_update`: value.user_id_update[{ wa_id, user_id: { previous, current } }]. */
async function processUserIdUpdate(value) {
  const updates = Array.isArray(value?.user_id_update) ? value.user_id_update : [];
  let n = 0;
  for (const u of updates) {
    try {
      await applyUserIdChange({ previous: u?.user_id?.previous, current: u?.user_id?.current, waId: u?.wa_id });
      n++;
    } catch (e) {
      logger.error(`[identity] user_id_update failed: ${e.message}`);
    }
  }
  return n;
}

module.exports = { senderIdentity, resolveContact, resolveChat, applyUserIdChange, processUserIdUpdate };
