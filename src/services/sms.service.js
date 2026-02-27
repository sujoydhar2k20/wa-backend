const axios = require('axios');
const { logger } = require('../utils/logger');

const BHS_USER = process.env.BHASHSMS_USER || '7278665321';
const BHS_PASS = process.env.BHASHSMS_PASS || 'a485bc9';
const BHS_SENDER = process.env.BHASHSMS_SENDER || 'BJSBIL';

const otpStore = new Map();

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function setOtp(phone, otp) {
  otpStore.set(phone, { otp, expiresAt: Date.now() + 10 * 60 * 1000 });
}

function verifyOtp(phone, otp) {
  const stored = otpStore.get(phone);
  if (!stored || stored.otp !== otp || Date.now() > stored.expiresAt) return false;
  otpStore.delete(phone);
  return true;
}

async function sendOtp(phone, otp) {
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

module.exports = { generateOtp, setOtp, verifyOtp, sendOtp };
