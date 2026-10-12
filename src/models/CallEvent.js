const mongoose = require('mongoose');

/**
 * Append-only diagnostics for WhatsApp calls (kept 90 days):
 *  - source 'meta'   : every Meta "calls" webhook (call_created / terminate / error statuses), incl. error codes
 *  - source 'client' : privacy-safe steps reported by the Android app / web panel (push received, answer tapped,
 *                      registered, invite received, connected, failed + reason)
 * Lets us tell apart: Meta rejected the call, our server rejected it, no staff device, signalling or media failure,
 * timeout, customer cancelled. No tokens, no message content.
 */
const callEventSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ['meta', 'client'], required: true },
    callLogId: { type: mongoose.Schema.Types.ObjectId, ref: 'CallLog', index: true },
    wacid: { type: String, index: true, sparse: true },   // Meta's call id
    phoneNumberId: { type: String },
    waId: { type: String },                                  // customer number digits (already stored in CallLog)
    direction: { type: String },                             // USER_INITIATED / BUSINESS_INITIATED (meta)
    event: { type: String, required: true },                 // call_created, terminate, status:<x>, or client step
    status: { type: String },                                // Meta status (COMPLETED/FAILED/...)
    errorList: [{ code: Number, title: String, message: String, meaning: String }], // Meta error codes + meaning
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    device: { type: String },                                // android | web
    detail: { type: String },                                // short, sanitised
    at: { type: Date, default: Date.now },
  },
  { timestamps: false }
);
callEventSchema.index({ at: 1 }, { expireAfterSeconds: 90 * 86400 });
callEventSchema.index({ source: 1, at: -1 });

module.exports = mongoose.model('CallEvent', callEventSchema);
