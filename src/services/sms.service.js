const axios = require('axios');
const { logger } = require('../utils/logger');

// SMS gateway credentials come only from the environment (no defaults in source).
const BHS_USER = process.env.BHASHSMS_USER;
const BHS_PASS = process.env.BHASHSMS_PASS;
const BHS_SENDER = process.env.BHASHSMS_SENDER || 'BJSBIL';

const OtpCode = require('../models/OtpCode');

// An OTP stays valid for 10 minutes. Requesting / resending within those 10 minutes re-sends the
// SAME code (so an SMS that arrives late is still usable); after that a new code is generated.
const OTP_TTL_MS = 10 * 60 * 1000;
// Minimum gap between two SMS to the same number (stops accidental double taps / SMS spam).
const RESEND_COOLDOWN_MS = 30 * 1000;
// Wrong guesses allowed before the code is thrown away and a new one must be requested.
const MAX_FAILED_ATTEMPTS = 5;

function generateOtp() {
  return String(require('crypto').randomInt(100000, 1000000));
}

/**
 * Returns the code to send for this phone: the still-valid existing one, or a fresh one.
 * { otp, expiresAt, shouldSend, retryAfterSec }
 */
async function issueOtp(phone) {
  const now = Date.now();
  const existing = await OtpCode.findOne({ phone });

  if (existing && existing.expiresAt.getTime() > now && existing.failedAttempts < MAX_FAILED_ATTEMPTS) {
    const sinceLast = now - existing.lastSentAt.getTime();
    if (sinceLast < RESEND_COOLDOWN_MS) {
      return {
        otp: existing.otp,
        expiresAt: existing.expiresAt,
        shouldSend: false,
        retryAfterSec: Math.ceil((RESEND_COOLDOWN_MS - sinceLast) / 1000),
      };
    }
    existing.lastSentAt = new Date(now);
    existing.sendCount += 1;
    await existing.save();
    return { otp: existing.otp, expiresAt: existing.expiresAt, shouldSend: true, retryAfterSec: 0 };
  }

  const otp = generateOtp();
  const expiresAt = new Date(now + OTP_TTL_MS);
  await OtpCode.findOneAndUpdate(
    { phone },
    { $set: { otp, expiresAt, lastSentAt: new Date(now), sendCount: 1, failedAttempts: 0 } },
    { upsert: true, returnDocument: 'after' }
  );
  return { otp, expiresAt, shouldSend: true, retryAfterSec: 0 };
}

/** Returns 'ok' | 'invalid' | 'expired'. A correct code is consumed (single use). */
async function verifyOtp(phone, otp) {
  const stored = await OtpCode.findOne({ phone });
  if (!stored || stored.expiresAt.getTime() <= Date.now() || stored.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    if (stored) await OtpCode.deleteOne({ _id: stored._id });
    return 'expired';
  }
  if (stored.otp !== String(otp || '').trim()) {
    await OtpCode.updateOne({ _id: stored._id }, { $inc: { failedAttempts: 1 } });
    return 'invalid';
  }
  await OtpCode.deleteOne({ _id: stored._id });
  return 'ok';
}

async function sendOtp(phone, otp) {
  if (!BHS_USER || !BHS_PASS) {
    logger.error('BhashSMS credentials are not configured (BHASHSMS_USER / BHASHSMS_PASS)');
    throw Object.assign(new Error('SMS service is not configured'), { statusCode: 500 });
  }
  let targetPhone = phone.replace('+91', '').replace('91', '');

  const text = `Use this OTP ${otp} to log in to your Biswakarma Jewellery Shilpalaya account and continue shopping`;
  const urlParams = new URLSearchParams({
    user: BHS_USER,
    pass: BHS_PASS,
    sender: "BJSBIL",
    phone: targetPhone,
    text: text,
    priority: 'ndnd',
    stype: 'normal'
  });

  const url = `https://bhashsms.com/api/sendmsg.php?${urlParams.toString()}`;
  try {
    await axios.get(url);
  } catch (err) {
    logger.error('BhashSMS send failed', { phone, err: err.message });
    throw err;
  }
}

module.exports = { generateOtp, issueOtp, verifyOtp, sendOtp, OTP_TTL_MS };
