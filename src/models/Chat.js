const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema(
  {
    sourceType: String, // "ad" or "post"
    sourceId: String, // ad id / post id (Meta does not send the campaign name)
    sourceUrl: String,
    headline: String,
    body: String,
    mediaType: String,
    imageUrl: String,
    videoUrl: String,
    thumbnailUrl: String,
    ctwaClid: String,
    welcomeMessage: String,
    messageId: String,
    receivedAt: Date,
  },
  { _id: false }
);

const chatSchema = new mongoose.Schema(
  {
    wabaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Waba', required: true, index: true },
    phoneNumberId: { type: String, required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', index: true },
    // Phone identity (digits). Optional since WhatsApp usernames: a customer may be known only by BSUID.
    phoneNumber: { type: String, index: true },
    waId: { type: String, index: true },
    // Business-scoped user ID (e.g. "US.13491208655302741918"). Never stored in phone fields.
    bsuid: { type: String, index: true },
    // Set when this chat was folded into another chat of the same customer (phone + BSUID identities).
    mergedInto: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat' },
    // Click-to-WhatsApp ad / post referrals (webhook messages[].referral). firstReferral never changes
    // once set; lastReferral is the most recent one; each message also stores its own in metadata.
    firstReferral: { type: referralSchema, default: undefined },
    lastReferral: { type: referralSchema, default: undefined },
    referralCount: { type: Number, default: 0 },
    status: { type: String, enum: ['open', 'closed', 'awaiting_reply'], default: 'open', index: true },
    isUnread: { type: Boolean, default: true },
    isManuallyUnread: { type: Boolean, default: false },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    collaborators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    tags: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Tag' }],
    sessionExpiresAt: { type: Date, index: true },
    lastMessageAt: { type: Date },
    lastCustomerMessageAt: { type: Date },
    lastStaffMessageAt: { type: Date },
    lastMessageText: { type: String },
    lastMessageDirection: { type: String, enum: ['inbound', 'outbound', 'internal'] },
    lastMessageStatus: { type: String },
    isDnd: { type: Boolean, default: false },
    lastNotificationAt: { type: Date },
    closedAt: { type: Date },
  },
  { timestamps: true }
);

chatSchema.pre('validate', function requireIdentity(next) {
  // A chat folded into another one keeps neither identity (they moved to the surviving chat).
  if (!this.mergedInto && !this.waId && !this.bsuid) this.invalidate('waId', 'A chat needs a phone number (waId) or a WhatsApp user ID (bsuid)');
  next();
});

// One chat per customer identity per WABA. Partial indexes so chats without a phone (BSUID-only) or
// without a BSUID do not collide. Existing databases: run scripts/migrate-bsuid-indexes.js once
// (replaces the old non-partial {wabaId, waId} unique index).
chatSchema.index({ wabaId: 1, waId: 1 }, { unique: true, name: 'wabaId_waId_unique_partial', partialFilterExpression: { waId: { $type: 'string' } } });
chatSchema.index({ wabaId: 1, bsuid: 1 }, { unique: true, name: 'wabaId_bsuid_unique_partial', partialFilterExpression: { bsuid: { $type: 'string' } } });
chatSchema.index({ assignedTo: 1, status: 1 });
chatSchema.index({ 'firstReferral.sourceId': 1 }, { sparse: true });
module.exports = mongoose.model('Chat', chatSchema);
