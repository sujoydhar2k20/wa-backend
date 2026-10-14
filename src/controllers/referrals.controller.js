/**
 * Basic Click-to-WhatsApp ad source reporting (no Conversions API, no Ads API calls).
 * Meta's webhook gives the ad/post id, headline and URL but not the campaign name.
 */
const mongoose = require('mongoose');
const { Chat, Message } = require('../models');

function range(query) {
  // Default: the last 30 days up to now (plus a minute of clock skew).
  const to = query.to ? new Date(query.to) : new Date(Date.now() + 60e3);
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 24 * 3600e3);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    const err = new Error('Invalid date range');
    err.statusCode = 400;
    throw err;
  }
  return { from, to };
}

/** GET /chats/referrals/report?from=&to=&wabaId= — per ad/post: new chats, chats, messages. Admins only. */
async function report(req, res, next) {
  try {
    const { from, to } = range(req.query);
    const waba = req.query.wabaId && mongoose.isValidObjectId(req.query.wabaId) ? { wabaId: new mongoose.Types.ObjectId(req.query.wabaId) } : {};

    // Every referral seen in the period (first and repeat ad clicks).
    const clicks = await Message.aggregate([
      { $match: { ...waba, direction: 'inbound', 'metadata.referral': { $exists: true }, createdAt: { $gte: from, $lte: to } } },
      { $sort: { createdAt: 1 } },
      { $group: {
        _id: { $ifNull: ['$metadata.referral.sourceId', '$metadata.referral.sourceUrl'] },
        sourceType: { $last: '$metadata.referral.sourceType' },
        headline: { $last: '$metadata.referral.headline' },
        sourceUrl: { $last: '$metadata.referral.sourceUrl' },
        clicks: { $sum: 1 },
        chats: { $addToSet: '$chatId' },
        firstAt: { $first: '$createdAt' },
        lastAt: { $last: '$createdAt' },
      } },
      { $project: { _id: 0, sourceId: '$_id', sourceType: 1, headline: 1, sourceUrl: 1, clicks: 1, chats: { $size: '$chats' }, firstAt: 1, lastAt: 1 } },
      { $sort: { clicks: -1 } },
      { $limit: 200 },
    ]);

    // Chats whose FIRST contact came from an ad in the period (new customers by ad).
    const firsts = await Chat.aggregate([
      { $match: { ...waba, mergedInto: null, 'firstReferral.receivedAt': { $gte: from, $lte: to } } },
      { $group: { _id: { $ifNull: ['$firstReferral.sourceId', '$firstReferral.sourceUrl'] }, newChats: { $sum: 1 } } },
    ]);
    const newBy = new Map(firsts.map((f) => [String(f._id), f.newChats]));
    const rows = clicks.map((r) => ({ ...r, newChats: newBy.get(String(r.sourceId)) || 0 }));

    res.json({
      from, to,
      totals: {
        clicks: rows.reduce((a, r) => a + r.clicks, 0),
        newChats: firsts.reduce((a, f) => a + f.newChats, 0),
        sources: rows.length,
      },
      rows,
    });
  } catch (e) {
    next(e);
  }
}

module.exports = { report, range };
