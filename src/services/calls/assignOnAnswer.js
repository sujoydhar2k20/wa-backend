'use strict';

/**
 * Inbound WhatsApp call answered: the customer's chat is assigned to the person who answered.
 *
 * Rules (agreed Oct 2026):
 *  - whoever answers (staff, admin or superadmin) becomes the assignee;
 *  - if the answerer is already the assignee, nothing changes;
 *  - chats tagged "monthly" are never reassigned automatically (superadmin-only rule stays);
 *  - unanswered calls never change the assignment (this runs only from CallFlow.answered, after the
 *    atomic single-winner update of the call log).
 *
 * The update is conditional on the assignee read a moment earlier, so a manual (re)assignment that
 * happens at the same instant is never overwritten.
 *
 * The new assignee is told who had the customer before (system message in the chat, the
 * "assigned to you" notification and the socket event), and the previous assignee is told
 * who took the customer over.
 */
const { Chat, ChatActivity, Message, User } = require('../../models');
const { logger } = require('../../utils/logger');

const sid = (v) => (v == null ? null : String(v._id || v));

/** Pure decision, unit-tested. */
function decide({ chat, answeredBy, isMonthlyChat }) {
  if (!chat || !answeredBy) return { action: 'none', reason: 'no-chat-or-answerer' };
  if (sid(chat.assignedTo) === sid(answeredBy)) return { action: 'none', reason: 'already-assigned' };
  if (isMonthlyChat) return { action: 'none', reason: 'monthly-chat' };
  return { action: 'assign', from: sid(chat.assignedTo), to: sid(answeredBy) };
}

/** Pure texts, unit-tested. [previousName] is null when the chat had no assignee. */
function assignmentTexts({ answererName, previousName, customerName }) {
  const who = answererName || 'A team member';
  const customer = customerName || 'a customer';
  const before = previousName ? `previously assigned to ${previousName}` : 'not assigned to anyone before';
  return {
    systemMessage: `${who} answered a WhatsApp call and was assigned this chat (${before})`,
    toNewAssignee: {
      title: 'Chat assigned to you',
      body: previousName
        ? `You answered ${customer}'s call. This customer was previously handled by ${previousName}.`
        : `You answered ${customer}'s call. This customer was not assigned to anyone before.`,
    },
    toPreviousAssignee: previousName
      ? { title: 'Chat reassigned', body: `${who} answered ${customer}'s call and is now handling this customer.` }
      : null,
  };
}

function notifySafe() {
  return async (n) => {
    try { await require('../notification.service').createNotification(n); } catch (_) { /* optional */ }
  };
}

function ioSafe() {
  try { return require('../../websocket/socket.server').getIO(); } catch (_) { return null; }
}

async function assignChatToAnswerer(callLog, deps = {}) {
  const models = { Chat, ChatActivity, Message, User, ...(deps.models || {}) };
  const isMonthly = deps.isMonthly || require('../../utils/tag').isMonthly;
  const getIO = deps.getIO || ioSafe;
  const notify = deps.notify || notifySafe();

  if (!callLog || callLog.direction !== 'inbound' || !callLog.chatId || !callLog.answeredBy) return { action: 'none', reason: 'not-applicable' };
  const chat = await models.Chat.findById(callLog.chatId).select('assignedTo tags wabaId').lean();
  const monthly = chat ? await isMonthly({ chat }) : false;
  const decision = decide({ chat, answeredBy: callLog.answeredBy, isMonthlyChat: monthly });
  if (decision.action !== 'assign') {
    if (decision.reason === 'monthly-chat') logger.info(`[calls] ${callLog._id}: monthly chat ${callLog.chatId} kept its assignee`);
    return decision;
  }

  const updated = await models.Chat.findOneAndUpdate(
    { _id: chat._id, assignedTo: chat.assignedTo || null },
    { $set: { assignedTo: callLog.answeredBy } },
    { new: true },
  );
  if (!updated) {
    logger.info(`[calls] ${callLog._id}: chat ${chat._id} assignment changed meanwhile, not overwritten`);
    return { action: 'none', reason: 'changed-meanwhile' };
  }

  const answerer = await models.User.findById(callLog.answeredBy).select('name phone').lean();
  const name = answerer?.name || 'A team member';
  const previousId = sid(chat.assignedTo);
  const previous = previousId ? await models.User.findById(previousId).select('name phone').lean() : null;
  const previousName = previousId ? (previous?.name || 'another team member') : null;
  const customerName = callLog.metadata?.contactName || (callLog.waId ? `+${callLog.waId}` : '');
  const texts = assignmentTexts({ answererName: answerer?.name, previousName, customerName });
  await models.ChatActivity.create({
    chatId: chat._id,
    type: 'assigned',
    performedBy: callLog.answeredBy,
    details: { assignedTo: callLog.answeredBy, fromStaffId: chat.assignedTo || undefined, toStaffId: callLog.answeredBy, reason: `call_answered:${callLog._id}` },
  });
  const sysMessage = await models.Message.create({
    chatId: chat._id,
    wabaId: chat.wabaId,
    direction: 'internal',
    type: 'system',
    text: texts.systemMessage,
    sentBy: callLog.answeredBy,
    metadata: {
      kind: 'assigned_by_call',
      callLogId: String(callLog._id),
      previousAssignee: previousId ? { id: previousId, name: previousName } : null,
    },
  });

  const io = getIO();
  if (io) {
    let populated = updated;
    try {
      populated = await models.Chat.findById(chat._id)
        .populate('contactId', 'name nameOnWhatsApp nickname profilePicture isOptedOut isBlocked customFields')
        .populate('assignedTo', 'name phone')
        .populate('wabaId', 'businessName phoneNumbers')
        .populate('collaborators', 'name phone')
        .populate('tags', 'name color');
    } catch (_) { /* fall back to the plain document */ }
    const payload = { chatId: String(chat._id), chat: populated, systemMessage: sysMessage };
    io.emit('chat:assigned', payload);
    io.emit('chat:update', payload);
    io.emit('message:new', { chatId: String(chat._id), message: sysMessage });
    io.to(`user:${sid(callLog.answeredBy)}`).emit('chat:assigned:me', {
      chatId: String(chat._id),
      chat: populated,
      assignedByName: 'WhatsApp call',
      previousAssigneeName: previousName,
    });
  }

  // Notification Center (and push) for both sides of the handover.
  const meta = { chatId: String(chat._id), callLogId: String(callLog._id), previousAssigneeName: previousName };
  await notify({ recipientId: callLog.answeredBy, type: 'assignment', ...texts.toNewAssignee, metadata: meta });
  if (previousId && texts.toPreviousAssignee) {
    await notify({ recipientId: previousId, type: 'assignment', ...texts.toPreviousAssignee, metadata: meta });
  }
  logger.info(`[calls] ${callLog._id}: chat ${chat._id} assigned to ${name} (was ${decision.from || 'unassigned'})`);
  return decision;
}

module.exports = { decide, assignmentTexts, assignChatToAnswerer };
