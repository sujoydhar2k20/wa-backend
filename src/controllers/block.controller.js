/**
 * Block / unblock a customer: always locally (BJS Connect stops showing and sending), and on WhatsApp
 * itself through the Meta Block Users API. The two results are reported separately and never faked:
 * if WhatsApp refuses or is unreachable, the local block still applies and the UI says WhatsApp failed.
 *
 * Permission: admins/superadmins for any chat; staff only for chats assigned to them.
 * Every action is written to BlockAudit (and the chat timeline).
 */
const { Chat, Contact, ChatActivity, BlockAudit } = require('../models');
const whatsappService = require('../services/whatsapp.service');
const { logger } = require('../utils/logger');
const { addressOf, phoneDigits, isBsuid } = require('../utils/waIdentity');

const isAdmin = (user) => ['admin', 'superadmin'].includes(user?.role);

function canUseChat(user, chat) {
  if (!user || !chat) return false;
  if (isAdmin(user)) return true;
  return String(chat.assignedTo?._id || chat.assignedTo || '') === String(user._id);
}

function maskIdentity(doc) {
  const digits = phoneDigits(doc?.waId) || phoneDigits(doc?.phoneNumber);
  if (digits) return `phone …${digits.slice(-4)}`;
  if (isBsuid(doc?.bsuid)) return `user id …${doc.bsuid.slice(-6)}`;
  return 'unknown';
}

function identityMatch(contact, chat) {
  const or = [];
  const digits = phoneDigits(contact?.waId) || phoneDigits(contact?.phoneNumber) || phoneDigits(chat?.waId);
  if (digits) or.push({ waId: digits }, { phoneNumber: digits });
  const bsuid = contact?.bsuid || chat?.bsuid;
  if (isBsuid(bsuid)) or.push({ bsuid });
  if (contact?._id) or.push({ _id: contact._id });
  return { $or: or };
}

/**
 * Core action, shared by the chat and contacts endpoints.
 * @returns {{ blocked: boolean, local: string, remote: object, message: string }}
 */
async function applyBlock({ contact, chat, blocked, user, source = 'chat', remote = true }) {
  // 1. Local block on every record of this customer (duplicates included), always first.
  const match = identityMatch(contact, chat);
  const before = await Contact.exists({ ...match, isBlocked: blocked ? { $ne: true } : true });
  await Contact.updateMany(match, { $set: { isBlocked: blocked, blockedAt: blocked ? new Date() : null } });
  const local = before ? 'applied' : 'unchanged';

  // 2. WhatsApp (Meta) block, from the business number this customer talks to.
  let remoteResult = { status: 'not_attempted', errorMessage: 'Not sent to WhatsApp.' };
  const target = chat || await Chat.findOne({ contactId: contact._id, mergedInto: null }).sort({ lastMessageAt: -1 });
  if (remote && target?.phoneNumberId) {
    const address = addressOf(target) || addressOf(contact);
    const r = await whatsappService.setUserBlocked(target.wabaId, target.phoneNumberId, address, blocked);
    remoteResult = r.ok
      ? { status: blocked ? 'blocked' : 'unblocked' }
      : { status: 'failed', errorCode: Number.isFinite(Number(r.code)) ? Number(r.code) : undefined, errorMessage: r.message };
    remoteResult.phoneNumberId = target.phoneNumberId;
  } else if (remote) {
    remoteResult.errorMessage = 'No WhatsApp conversation with this customer yet.';
  }
  const remoteBlock = { ...remoteResult, action: blocked ? 'block' : 'unblock', at: new Date() };
  await Contact.updateMany(match, { $set: { remoteBlock } });

  // 3. Audit + chat timeline. Failures here must not undo the block, but they are logged.
  try {
    await BlockAudit.create({
      contactId: contact?._id, chatId: target?._id, action: blocked ? 'block' : 'unblock',
      performedBy: user?._id, role: user?.role, source, local, remote: remoteResult.status,
      remoteErrorCode: remoteResult.errorCode, remoteErrorMessage: remoteResult.errorMessage,
      phoneNumberId: remoteResult.phoneNumberId, identity: maskIdentity(contact || target),
    });
    if (target?._id) {
      await ChatActivity.create({
        chatId: target._id, type: blocked ? 'blocked' : 'unblocked', performedBy: user?._id,
        details: { reason: `WhatsApp: ${remoteResult.status}${remoteResult.errorMessage && remoteResult.status === 'failed' ? ` (${remoteResult.errorMessage})` : ''}` },
      });
    }
  } catch (e) {
    logger.error(`[block] audit write failed: ${e.message}`);
  }
  logger.info(`[block] ${blocked ? 'block' : 'unblock'} ${maskIdentity(contact || target)} by ${user?._id}: local=${local} whatsapp=${remoteResult.status}${remoteResult.errorCode ? ` (${remoteResult.errorCode})` : ''}`);

  let message;
  if (remoteResult.status === (blocked ? 'blocked' : 'unblocked')) message = blocked ? 'Blocked in BJS Connect and on WhatsApp.' : 'Unblocked in BJS Connect and on WhatsApp.';
  else if (remoteResult.status === 'failed') message = `${blocked ? 'Blocked' : 'Unblocked'} in BJS Connect only. WhatsApp: ${remoteResult.errorMessage}`;
  else message = `${blocked ? 'Blocked' : 'Unblocked'} in BJS Connect only (${remoteResult.errorMessage})`;

  return { blocked, local, remote: remoteBlock, message };
}

/** POST /chats/:id/block { blocked: boolean = true, whatsapp: boolean = true } */
async function blockChat(req, res, next) {
  try {
    const chat = await Chat.findById(req.params.id);
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
    if (!canUseChat(req.user, chat)) return res.status(403).json({ success: false, message: 'Only an admin or the assigned staff member can block this customer.' });
    const contact = chat.contactId ? await Contact.findById(chat.contactId) : null;
    if (!contact) return res.status(404).json({ success: false, message: 'Customer record not found' });
    const blocked = req.body?.blocked !== false;
    const result = await applyBlock({ contact, chat, blocked, user: req.user, source: 'chat', remote: req.body?.whatsapp !== false });
    try {
      require('../websocket/socket.server').getIO().emit('contact:block', { chatId: String(chat._id), contactId: String(contact._id), isBlocked: blocked, remoteBlock: result.remote });
    } catch (_) { /* socket optional */ }
    res.json({ success: true, ...result });
  } catch (e) {
    next(e);
  }
}

/** GET /chats/:id/block — current local + WhatsApp status and the last audit entries. */
async function blockStatus(req, res, next) {
  try {
    const chat = await Chat.findById(req.params.id).select('contactId assignedTo');
    if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });
    if (!canUseChat(req.user, chat)) return res.status(403).json({ success: false, message: 'Not allowed' });
    const contact = await Contact.findById(chat.contactId).select('isBlocked blockedAt remoteBlock').lean();
    const history = await BlockAudit.find({ contactId: chat.contactId }).sort({ createdAt: -1 }).limit(10)
      .populate('performedBy', 'name').select('-identity').lean();
    res.json({ isBlocked: !!contact?.isBlocked, blockedAt: contact?.blockedAt, remoteBlock: contact?.remoteBlock || null, history });
  } catch (e) {
    next(e);
  }
}

module.exports = { applyBlock, blockChat, blockStatus, canUseChat };
