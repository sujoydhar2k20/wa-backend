'use strict';

/**
 * Idempotency for POST /messages/send.
 *
 * claim()    -> { claimed: true } the caller must send, then complete() or release()
 *            -> { existing: <Message id> } already sent: return that message, do not send again
 *            -> { inProgress: true } another request with the same id is sending right now
 *
 * A pending claim older than STALE_MS (server crashed mid-send) can be taken over.
 */
const SendRequest = require('../models/SendRequest');

const STALE_MS = 5 * 60 * 1000;
const MAX_ID_LENGTH = 100;

function normalizeClientId(value) {
  const id = String(value == null ? '' : value).trim();
  if (!id || id.length > MAX_ID_LENGTH || !/^[A-Za-z0-9_.:-]+$/.test(id)) return null;
  return id;
}

const keyFor = (chatId, clientMessageId) => `${String(chatId)}:${clientMessageId}`;

async function claim({ chatId, clientMessageId, userId, now = new Date() }) {
  const key = keyFor(chatId, clientMessageId);
  try {
    await SendRequest.create({ key, chatId, clientMessageId, userId, status: 'pending', claimedAt: now });
    return { claimed: true, key };
  } catch (e) {
    if (e.code !== 11000) throw e;
  }
  const row = await SendRequest.findOne({ key }).lean();
  if (!row) return claim({ chatId, clientMessageId, userId, now }); // released in between
  if (row.status === 'done' && row.messageId) return { existing: row.messageId, key };
  if (now.getTime() - new Date(row.claimedAt).getTime() > STALE_MS) {
    const taken = await SendRequest.findOneAndUpdate(
      { key, status: 'pending', claimedAt: row.claimedAt },
      { $set: { claimedAt: now, userId } },
      { returnDocument: 'after' },
    );
    if (taken) return { claimed: true, key };
  }
  return { inProgress: true, key };
}

async function complete(key, messageId) {
  await SendRequest.updateOne({ key }, { $set: { status: 'done', messageId } });
}

async function release(key) {
  await SendRequest.deleteOne({ key, status: 'pending' });
}

module.exports = { claim, complete, release, normalizeClientId, keyFor, STALE_MS };
