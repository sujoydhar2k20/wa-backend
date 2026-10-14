'use strict';

/**
 * Background (asynchronous) media sends.
 *
 * Lifecycle of a message with pipeline.mode === 'async' (Message.status stays 'queued' until Meta answers):
 *   queued -> preparing -> uploading_media -> ready -> sending -> sent      (status 'sent', wamid stored)
 *                                                            \-> failed    (status 'failed', error stored)
 *                                                            \-> unconfirmed -> sent (webhook matched)
 *                                                                            -> failed (no confirmation)
 * - The HTTP request returns 202 only after the Message and its Agenda job are stored in MongoDB.
 * - Preparation + Meta upload run in parallel (bounded); the final WhatsApp send is done in creation order
 *   per chat (dispatchChat), so customers receive a chat's media in the order staff sent them.
 * - Every stage change is an atomic, guarded update that bumps pipeline.version and emits
 *   `message:pipeline`; final outcomes also emit the existing `message:status` event.
 * - A send whose outcome is unknown is never re-sent automatically (see mediaPipeline.sendOnce).
 */
const mongoose = require('mongoose');
const { Message, Chat } = require('../../models');
const { logger } = require('../../utils/logger');
const { addressOf } = require('../../utils/waIdentity');
const { statusGuard } = require('../messageStatus');
const pipe = require('./mediaPipeline');
const { CONCURRENCY, MAX_PENDING_MEDIA } = require('./limits');

const JOB_PROCESS = 'media-message:process';
const JOB_LATER = 'media-message:later';
const JOB_SWEEP = 'media-message:sweep';

const LEASE_MS = 15 * 60 * 1000;          // a preparing job older than this is considered dead
const SENDING_STALE_MS = 3 * 60 * 1000;   // a 'sending' row older than this lost its worker
const UNCONFIRMED_WAIT_MS = 3 * 60 * 1000; // wait this long for a webhook before declaring failure
const MAX_PREPARE_ATTEMPTS = 3;
const MAX_SEND_ROUNDS = 4;
const TERMINAL = new Set(['sent', 'failed']);

function io() {
  try {
    return require('../../websocket/socket.server').getIO();
  } catch {
    return null;
  }
}

/** The pipeline object as clients see it (no server paths, no tokens). */
function pipelineView(p) {
  if (!p) return null;
  const { mode, stage, active, version, attempts, sendAttempts, retries, timings, error, prepareAction, reasons, waitingForEarlier } = p;
  return { mode, stage, active, version, attempts, sendAttempts, retries, timings, error, prepareAction, reasons, waitingForEarlier };
}

function emitPipeline(msg) {
  const s = io();
  if (!s || !msg) return;
  s.emit('message:pipeline', {
    chatId: String(msg.chatId),
    messageId: String(msg._id),
    clientMessageId: msg.clientMessageId || null,
    status: msg.status,
    waMessageId: msg.messageId || null,
    errorCode: msg.errorCode ?? null,
    errorMessage: msg.errorMessage || null,
    pipeline: pipelineView(msg.pipeline),
  });
  if (msg.status === 'sent' || msg.status === 'failed') {
    // Older clients only know this event.
    s.emit('message:status', {
      chatId: String(msg.chatId),
      messageId: String(msg._id),
      waMessageId: msg.messageId || undefined,
      status: msg.status,
      ...(msg.status === 'failed' ? { errorCode: msg.errorCode, errorMessage: msg.errorMessage } : {}),
    });
  }
}

/**
 * Atomic guarded update: applies `set` only when `filter` still matches; bumps version + stageAt.
 * Returns the updated message (with mediaWork) or null when the guard did not match.
 */
async function transition(id, filter, set, { unset, inc } = {}) {
  const now = new Date();
  const update = {
    $set: { ...set, 'pipeline.stageAt': now },
    $inc: { 'pipeline.version': 1, ...(inc || {}) },
  };
  if (unset) update.$unset = unset;
  const doc = await Message.findOneAndUpdate({ _id: id, ...filter }, update, { new: true }).select('+mediaWork');
  if (doc) emitPipeline(doc);
  return doc;
}

const iso = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------------------
// Enqueue

function getAgenda() {
  return require('../../jobs/agenda').getAgenda();
}

/** Durably store the processing job (one per message). Throws when the queue is not available. */
async function enqueueProcess(messageId) {
  const agenda = getAgenda();
  if (!agenda) throw Object.assign(new Error('Background queue is not running'), { statusCode: 503 });
  const job = agenda.create(JOB_PROCESS, { messageId: String(messageId) });
  job.unique({ name: JOB_PROCESS, 'data.messageId': String(messageId) });
  job.schedule(new Date());
  await job.save();
  return job;
}

async function scheduleLater(seconds, data) {
  const agenda = getAgenda();
  if (!agenda) return;
  await agenda.schedule(new Date(Date.now() + seconds * 1000), JOB_LATER, data);
}

async function pendingCount() {
  return Message.countDocuments({ 'pipeline.active': true });
}

async function assertCapacity() {
  const n = await pendingCount();
  if (n >= MAX_PENDING_MEDIA) {
    const e = new Error('The server is busy sending other files. Please try again in a moment.');
    e.statusCode = 503;
    e.code = 'MEDIA_QUEUE_FULL';
    throw e;
  }
}

/** Initial pipeline object for a message accepted by POST /messages/send with async:true. */
function newPipeline({ wantsVoice, clientTimings }) {
  const timings = { acceptedAt: iso() };
  if (clientTimings && typeof clientTimings === 'object') {
    // Client-measured (monotonic) upload numbers, clamped to sane values; labelled as client data.
    const n = (v, max) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= max ? Math.round(Number(v)) : undefined);
    timings.client = {
      uploadMs: n(clientTimings.uploadMs, 3600e3),
      uploadBytes: n(clientTimings.uploadBytes, 2 ** 40),
      queuedMs: n(clientTimings.queuedMs, 24 * 3600e3),
      preprocessMs: n(clientTimings.preprocessMs, 3600e3),
    };
  }
  return { mode: 'async', stage: 'queued', active: true, version: 1, attempts: 0, sendAttempts: 0, retries: 0, wantsVoice: Boolean(wantsVoice), timings };
}

// ---------------------------------------------------------------------------------------------------------
// Stage 1: prepare + upload to Meta (parallel, bounded by Agenda concurrency + semaphores)

async function processMessage(messageId) {
  const now = Date.now();
  const msg = await Message.findById(messageId).select('+mediaWork');
  if (!msg || msg.pipeline?.mode !== 'async' || !msg.pipeline.active) return;
  if (['ready', 'sending', 'unconfirmed'].includes(msg.pipeline.stage)) {
    await dispatchChat(msg.chatId);
    return;
  }
  // Claim: queued, or a preparing job whose lease expired (worker died).
  const claimed = await transition(messageId, {
    status: 'queued',
    'pipeline.active': true,
    $or: [
      { 'pipeline.stage': 'queued' },
      { 'pipeline.stage': { $in: ['preparing', 'uploading_media'] }, 'pipeline.leaseUntil': { $lt: new Date(now) } },
    ],
  }, {
    'pipeline.stage': 'preparing',
    'pipeline.leaseUntil': new Date(now + LEASE_MS),
    'pipeline.timings.prepareStartedAt': iso(),
  }, { inc: { 'pipeline.attempts': 1 } });
  if (!claimed) return;

  const chat = await Chat.findById(claimed.chatId);
  if (!chat) {
    await failMessage(claimed._id, 'prepare', new Error('Chat not found'));
    return;
  }
  const p = claimed.pipeline;
  const work = claimed.mediaWork || {};
  const wantsVoice = p.wantsVoice && Number(claimed.errorCode) !== 131053;
  let prepared = null;
  try {
    // Reuse what an earlier attempt already did.
    if (pipe.metaMediaReusable(work, chat, wantsVoice)) {
      await transition(claimed._id, { 'pipeline.stage': 'preparing' }, {
        'pipeline.stage': 'ready',
        'pipeline.timings.prepareEndedAt': iso(),
        'pipeline.timings.metaUploadReused': true,
        'pipeline.waitingForEarlier': false,
      }, { unset: { 'pipeline.leaseUntil': 1 } });
      await dispatchChat(claimed.chatId);
      return;
    }
    let file;
    let sentAsVoice = Boolean(work.sentAsVoice);
    let voiceNotice = work.voiceNotice;
    if (work.preparedPath && await pipe.fileExists(work.preparedPath) && work.preparedMime) {
      const st = await require('fs').promises.stat(work.preparedPath);
      file = { path: work.preparedPath, mimeType: work.preparedMime, size: st.size };
    } else {
      prepared = await pipe.prepareMedia({
        type: claimed.type,
        mediaUrl: claimed.mediaUrl,
        wantsVoice: p.wantsVoice,
        voiceRejected: Number(claimed.errorCode) === 131053,
        keepPrepared: true,
      });
      file = prepared.file;
      sentAsVoice = prepared.sentAsVoice;
      voiceNotice = prepared.voiceNotice;
      await Message.updateOne({ _id: claimed._id }, {
        $set: {
          'mediaWork.preparedPath': prepared.persistedPath || null,
          'mediaWork.preparedMime': prepared.persistedPath ? file.mimeType : null,
          'mediaWork.sentAsVoice': sentAsVoice,
          'mediaWork.voiceNotice': voiceNotice || null,
        },
      });
    }
    const t = prepared?.timings || {};
    await transition(claimed._id, { 'pipeline.stage': 'preparing' }, {
      'pipeline.stage': 'uploading_media',
      'pipeline.timings.prepareEndedAt': iso(),
      ...(prepared ? {
        'pipeline.timings.sourceMs': t.sourceMs,
        'pipeline.timings.sourceLocal': t.sourceLocal,
        'pipeline.timings.prepareMs': t.prepareMs,
        ...(t.convertMs != null ? { 'pipeline.timings.convertMs': t.convertMs } : {}),
        'pipeline.prepareAction': prepared.action,
        'pipeline.reasons': prepared.reasons,
        'pipeline.timings.inputBytes': prepared.details.inputBytes,
        'pipeline.timings.outputBytes': file.size,
      } : {}),
      'pipeline.timings.metaUploadStartedAt': iso(),
    });

    const up = await pipe.uploadToMeta(chat, file);
    await Message.updateOne({ _id: claimed._id }, {
      $set: {
        'mediaWork.metaMediaId': up.mediaId,
        'mediaWork.metaMediaUploadedAt': new Date(),
        'mediaWork.phoneNumberId': chat.phoneNumberId,
        'mediaWork.sentAsVoice': sentAsVoice,
        'mediaWork.voiceNotice': voiceNotice || null,
      },
    });
    await transition(claimed._id, { 'pipeline.stage': 'uploading_media' }, {
      'pipeline.stage': 'ready',
      'pipeline.timings.metaUploadMs': up.ms,
      'pipeline.timings.metaUploadedAt': iso(),
    }, { unset: { 'pipeline.leaseUntil': 1 } });
  } catch (err) {
    const transient = !err.permanent && (err.code === 'VIDEO_TIMEOUT' || pipe.classifyMetaError(err).kind !== 'fatal');
    const attempts = claimed.pipeline.attempts || 1;
    logger.warn(`[media] prepare/upload failed for ${claimed._id} (attempt ${attempts}, ${transient ? 'transient' : 'permanent'}): ${err.message}`);
    if (transient && attempts < MAX_PREPARE_ATTEMPTS) {
      const backoff = [10, 30, 90][attempts - 1] || 90;
      await transition(claimed._id, { 'pipeline.stage': { $in: ['preparing', 'uploading_media'] } }, {
        'pipeline.stage': 'queued',
        'pipeline.error': { stage: 'prepare', message: pipe.userError(err), at: iso(), willRetry: true },
      }, { unset: { 'pipeline.leaseUntil': 1 } });
      await scheduleLater(backoff, { kind: 'process', messageId: String(claimed._id) });
    } else {
      await failMessage(claimed._id, 'prepare', err);
    }
    return;
  } finally {
    if (prepared) await prepared.cleanup();
  }
  await dispatchChat(claimed.chatId);
}

async function failMessage(id, stage, err, { code } = {}) {
  const message = pipe.userError(err);
  const doc = await transition(id, { 'pipeline.active': true }, {
    status: 'failed',
    errorMessage: message,
    ...(code != null || err?.metaCode != null ? { errorCode: code ?? err.metaCode } : {}),
    'pipeline.stage': 'failed',
    'pipeline.active': false,
    'pipeline.error': { stage, message, at: iso(), willRetry: false },
    'pipeline.timings.failedAt': iso(),
  }, { unset: { 'pipeline.leaseUntil': 1 } });
  if (doc) {
    logger.warn(`[media] message ${id} failed at ${stage}: ${message}`);
    await syncChatStatus(doc);
  }
  return doc;
}

async function syncChatStatus(msg) {
  try {
    const latest = await Message.findOne({ chatId: msg.chatId }).sort({ createdAt: -1 }).select('_id');
    if (latest && String(latest._id) === String(msg._id)) {
      await Chat.updateOne({ _id: msg.chatId }, { $set: { lastMessageStatus: msg.status } });
    }
  } catch (e) {
    logger.warn(`[media] chat status sync failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Stage 2: ordered dispatch per chat

const dispatching = new Set(); // chats being dispatched by this process (cheap local de-dup)

async function dispatchChat(chatId) {
  const key = String(chatId);
  if (dispatching.has(key)) {
    dispatching.add(`${key}:again`);
    return;
  }
  dispatching.add(key);
  try {
    let rounds = 0;
    do {
      dispatching.delete(`${key}:again`);
      // eslint-disable-next-line no-await-in-loop
      while (await dispatchNext(chatId)) {
        rounds += 1;
        if (rounds > 500) break;
      }
    } while (dispatching.has(`${key}:again`));
  } finally {
    dispatching.delete(key);
    dispatching.delete(`${key}:again`);
  }
}

/** Sends the earliest unfinished async media message of the chat if it is ready. Returns true to continue. */
async function dispatchNext(chatId) {
  const head = await Message.findOne({ chatId, 'pipeline.active': true, 'pipeline.mode': 'async' })
    .sort({ createdAt: 1, _id: 1 }).select('+mediaWork');
  if (!head) return false;
  if (head.pipeline.stage !== 'ready') {
    // Later ready messages wait for this one; tell clients so their UI can say so.
    await Message.updateMany(
      { chatId, 'pipeline.active': true, 'pipeline.mode': 'async', 'pipeline.stage': 'ready', _id: { $ne: head._id }, 'pipeline.waitingForEarlier': { $ne: true } },
      { $set: { 'pipeline.waitingForEarlier': true }, $inc: { 'pipeline.version': 1 } },
    );
    const waiting = await Message.find({ chatId, 'pipeline.active': true, 'pipeline.stage': 'ready', 'pipeline.waitingForEarlier': true });
    waiting.forEach(emitPipeline);
    return false;
  }
  const claimed = await transition(head._id, { 'pipeline.stage': 'ready', 'pipeline.active': true }, {
    'pipeline.stage': 'sending',
    'pipeline.waitingForEarlier': false,
    'pipeline.timings.sendStartedAt': iso(),
  }, { inc: { 'pipeline.sendAttempts': 1 } });
  if (!claimed) return true; // someone else took it; look again

  const chat = await Chat.findById(claimed.chatId);
  if (!chat) {
    await failMessage(claimed._id, 'send', new Error('Chat not found'));
    return true;
  }
  const work = claimed.mediaWork || {};
  let replyWamid = null;
  if (claimed.replyToMessageId) {
    const parent = await Message.findById(claimed.replyToMessageId).select('messageId');
    replyWamid = parent?.messageId || null;
  }
  const attempt = claimed.pipeline.sendAttempts || 1;
  const result = await pipe.sendOnce({
    chat,
    to: addressOf(chat),
    type: claimed.type,
    mediaIdOrUrl: work.metaMediaId,
    caption: claimed.type === 'audio' ? '' : claimed.caption,
    replyWamid,
    voice: Boolean(work.sentAsVoice),
    bizOpaque: `bjs:${claimed._id}:${attempt}`,
    retries: 1,
  });

  if (result.ok) {
    await markSent(claimed, result.wamid, result.ms, work);
    return true;
  }
  if (result.kind === 'fatal') {
    await failMessage(claimed._id, 'send', result.error, { code: result.error?.metaCode });
    return true;
  }
  if (result.kind === 'retry' && attempt < MAX_SEND_ROUNDS) {
    // Certainly not sent: keep the slot (order) and try again shortly.
    await transition(claimed._id, { 'pipeline.stage': 'sending' }, {
      'pipeline.stage': 'ready',
      'pipeline.error': { stage: 'send', message: pipe.userError(result.error), at: iso(), willRetry: true },
    });
    await scheduleLater(15 * attempt, { kind: 'dispatch', chatId: String(claimed.chatId) });
    return false;
  }
  if (result.kind === 'retry') {
    await failMessage(claimed._id, 'send', result.error);
    return true;
  }
  // Ambiguous: Meta may have accepted it. Never re-send; wait for a webhook carrying our callback data.
  await transition(claimed._id, { 'pipeline.stage': 'sending' }, {
    'pipeline.stage': 'unconfirmed',
    'pipeline.active': false,
    'pipeline.timings.unconfirmedAt': iso(),
    'pipeline.error': {
      stage: 'send',
      message: `WhatsApp did not confirm the send (${result.reason || 'no response'}). Checking...`,
      at: iso(),
      willRetry: false,
    },
  });
  return true;
}

async function markSent(msgDoc, wamid, sendMs, work) {
  const id = msgDoc._id;
  const set = {
    'pipeline.stage': 'sent',
    'pipeline.active': false,
    'pipeline.timings.sendMs': sendMs,
    'pipeline.timings.sentAt': iso(),
    'pipeline.error': null,
  };
  if (msgDoc.type === 'audio') {
    set.metadata = { ...(msgDoc.metadata || {}), voice: Boolean(work.sentAsVoice), ...(work.voiceNotice ? { voiceNotice: work.voiceNotice } : {}) };
    if (msgDoc.pipeline?.wantsVoice && !work.sentAsVoice && Number(msgDoc.errorCode) === 131053) {
      set.metadata.voiceNotice = 'sent_as_audio_after_rejection';
    }
  }
  // 1) store the WhatsApp id (unless a webhook already reconciled it)
  await Message.updateOne({ _id: id, $or: [{ messageId: null }, { messageId: { $exists: false } }] }, { $set: { messageId: wamid } });
  // 2) status -> sent only if still behind 'sent' (a fast webhook may already have said delivered/read)
  await Message.updateOne({ _id: id, ...statusGuard('sent') }, { $set: { status: 'sent', statusTimestamp: new Date() }, $unset: { errorCode: 1, errorMessage: 1 } });
  const doc = await transition(id, {}, set, { unset: { errorCode: 1, errorMessage: 1 } });
  if (work?.preparedPath) {
    await pipe.removePrepared(work.preparedPath);
    await Message.updateOne({ _id: id }, { $unset: { 'mediaWork.preparedPath': 1, 'mediaWork.preparedMime': 1 } });
  }
  if (doc) await syncChatStatus(doc);
  return doc;
}

// ---------------------------------------------------------------------------------------------------------
// Webhook reconciliation (status for a wamid we never stored because the send response was lost)

const OPAQUE_RE = /^bjs:([a-f0-9]{24}):(\d+)$/;

/** Returns true when the status was matched to one of our messages via biz_opaque_callback_data. */
async function reconcileFromWebhook(statusObj) {
  const m = OPAQUE_RE.exec(String(statusObj?.biz_opaque_callback_data || ''));
  if (!m || !statusObj.id) return false;
  const id = m[1];
  if (!mongoose.isValidObjectId(id)) return false;
  const res = await Message.findOneAndUpdate(
    { _id: id, $or: [{ messageId: null }, { messageId: { $exists: false } }] },
    {
      $set: {
        messageId: statusObj.id,
        'pipeline.stage': 'sent',
        'pipeline.active': false,
        'pipeline.reconciledBy': 'webhook',
        'pipeline.timings.sentAt': new Date(Number(statusObj.timestamp) * 1000 || Date.now()).toISOString(),
        'pipeline.error': null,
      },
      $unset: { errorCode: 1, errorMessage: 1 },
      $inc: { 'pipeline.version': 1 },
    },
    { new: true },
  );
  if (res) {
    logger.info(`[media] message ${id} matched to ${statusObj.id} via webhook callback data`);
    emitPipeline(res);
  }
  return Boolean(res);
}

// ---------------------------------------------------------------------------------------------------------
// Retry (user action)

/**
 * Put a failed media message back into the async pipeline. Only the failed stage is redone:
 * a fresh Meta media id skips preparation and upload; a kept prepared file skips preparation.
 */
async function retryAsync(messageId) {
  const msg = await Message.findById(messageId).select('+mediaWork');
  if (!msg) return { error: 404 };
  if (!pipe.MEDIA_TYPES.includes(msg.type)) return { error: 400 };
  if (msg.status !== 'failed' && !(msg.pipeline?.stage === 'failed')) return { error: 409, message: msg };
  const chat = await Chat.findById(msg.chatId);
  const wantsVoice = msg.pipeline?.wantsVoice ?? (msg.type === 'audio' && msg.metadata?.voice === true);
  // 131053 = WhatsApp refused the voice file: the retry must convert again and go out as plain audio.
  const reuse = chat && pipe.metaMediaReusable(msg.mediaWork, chat, wantsVoice && Number(msg.errorCode) !== 131053);
  const firstAccepted = msg.pipeline?.timings?.firstAcceptedAt || msg.pipeline?.timings?.acceptedAt || msg.createdAt?.toISOString();
  const pipeline = {
    ...(msg.pipeline || {}),
    mode: 'async',
    stage: reuse ? 'ready' : 'queued',
    active: true,
    version: (msg.pipeline?.version || 0) + 1,
    attempts: 0,
    sendAttempts: 0,
    retries: (msg.pipeline?.retries || 0) + 1,
    wantsVoice,
    error: null,
    stageAt: new Date(),
    timings: {
      firstAcceptedAt: firstAccepted,
      acceptedAt: iso(),
      retriedAt: iso(),
      ...(reuse ? { metaUploadReused: true } : {}),
    },
  };
  const updated = await Message.findOneAndUpdate(
    { _id: msg._id, status: 'failed' },
    // errorCode is kept until the send succeeds: 131053 makes the voice retry go out as plain audio.
    { $set: { status: 'queued', pipeline }, $unset: { errorMessage: 1 } },
    { new: true },
  ).select('+mediaWork');
  if (!updated) return { error: 409, message: msg };
  emitPipeline(updated);
  if (reuse) await dispatchChat(updated.chatId);
  else await enqueueProcess(updated._id);
  // Return the current state (the dispatch above may already have sent it), never an older snapshot.
  return { message: (await Message.findById(updated._id)) || updated };
}

// ---------------------------------------------------------------------------------------------------------
// Recovery sweep (every minute): restarts, crashes, lost jobs, unconfirmed sends

async function sweep() {
  const now = Date.now();
  // 1) queued with no running job for a while -> enqueue again (unique job, so never duplicated)
  const stuckQueued = await Message.find({
    'pipeline.active': true, 'pipeline.mode': 'async', 'pipeline.stage': 'queued',
    'pipeline.stageAt': { $lt: new Date(now - 2 * 60 * 1000) },
  }).select('_id').limit(100);
  for (const m of stuckQueued) await enqueueProcess(m._id).catch(() => {});
  // 2) preparing with an expired lease -> enqueue (processMessage takes it over)
  const deadPrep = await Message.find({
    'pipeline.active': true, 'pipeline.stage': { $in: ['preparing', 'uploading_media'] }, 'pipeline.leaseUntil': { $lt: new Date(now) },
  }).select('_id').limit(100);
  for (const m of deadPrep) await enqueueProcess(m._id).catch(() => {});
  // 3) sending for too long (worker died mid-send) -> unconfirmed (never re-sent automatically)
  const deadSend = await Message.find({
    'pipeline.active': true, 'pipeline.stage': 'sending', 'pipeline.stageAt': { $lt: new Date(now - SENDING_STALE_MS) },
  }).select('_id');
  for (const m of deadSend) {
    await transition(m._id, { 'pipeline.stage': 'sending' }, {
      'pipeline.stage': 'unconfirmed', 'pipeline.active': false, 'pipeline.timings.unconfirmedAt': iso(),
      'pipeline.error': { stage: 'send', message: 'The server restarted while sending. Checking with WhatsApp...', at: iso(), willRetry: false },
    });
  }
  // 4) unconfirmed with no webhook match -> failed, with an honest message
  const unconfirmed = await Message.find({
    'pipeline.stage': 'unconfirmed', 'pipeline.stageAt': { $lt: new Date(now - UNCONFIRMED_WAIT_MS) },
    $or: [{ messageId: null }, { messageId: { $exists: false } }],
  }).select('_id');
  for (const m of unconfirmed) {
    const doc = await transition(m._id, { 'pipeline.stage': 'unconfirmed', $or: [{ messageId: null }, { messageId: { $exists: false } }] }, {
      status: 'failed',
      errorMessage: 'WhatsApp did not confirm this message. It may still have reached the customer: check before retrying.',
      'pipeline.stage': 'failed',
      'pipeline.error': { stage: 'send-unconfirmed', message: 'WhatsApp did not confirm this message. It may still have reached the customer: check before retrying.', at: iso(), willRetry: false },
      'pipeline.timings.failedAt': iso(),
    });
    if (doc) await syncChatStatus(doc);
  }
  // 5) chats whose head message is ready but nobody is dispatching
  const readyChats = await Message.distinct('chatId', {
    'pipeline.active': true, 'pipeline.stage': 'ready', 'pipeline.stageAt': { $lt: new Date(now - 60 * 1000) },
  });
  for (const chatId of readyChats) await dispatchChat(chatId);
}

// ---------------------------------------------------------------------------------------------------------
// Agenda wiring

function defineJobs(agenda) {
  agenda.define(JOB_PROCESS, { concurrency: CONCURRENCY.jobs, lockLifetime: LEASE_MS }, async (job) => {
    try {
      await processMessage(job.attrs.data.messageId);
    } finally {
      // Finished jobs are not kept (one per message would pile up); the message row holds the state.
      await job.remove().catch(() => {});
    }
  });
  agenda.define(JOB_LATER, { concurrency: CONCURRENCY.jobs, lockLifetime: LEASE_MS }, async (job) => {
    const d = job.attrs.data || {};
    if (d.kind === 'process' && d.messageId) await processMessage(d.messageId);
    else if (d.kind === 'dispatch' && d.chatId) await dispatchChat(d.chatId);
    await job.remove().catch(() => {});
  });
  agenda.define(JOB_SWEEP, { concurrency: 1, lockLifetime: 5 * 60 * 1000 }, async () => {
    await sweep();
  });
}

module.exports = {
  JOB_PROCESS, JOB_LATER, JOB_SWEEP,
  defineJobs,
  newPipeline,
  enqueueProcess,
  assertCapacity,
  processMessage,
  dispatchChat,
  retryAsync,
  reconcileFromWebhook,
  sweep,
  emitPipeline,
  pipelineView,
  failMessage,
  TERMINAL,
};
