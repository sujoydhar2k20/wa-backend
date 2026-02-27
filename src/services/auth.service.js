const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const Session = require('../models/Session');
const smsService = require('./sms.service');
const { logger } = require('../utils/logger');

const SESSION_VALIDITY_DAYS = 365;

function generateTokens(userId) {
  const accessToken = jwt.sign({ userId }, config.jwt.secret, { expiresIn: config.jwt.expiry });
  const refreshToken = jwt.sign({ userId }, config.jwt.secret, { expiresIn: config.jwt.refreshExpiry });
  return { accessToken, refreshToken };
}

function isSuperAdmin(phone) {
  const sa = config.superAdminPhone?.replace(/\D/g, '');
  return sa && sa === phone;
}

async function sendOtp(phone) {
  const normalized = phone.replace(/\D/g, '');
  if (!normalized) throw Object.assign(new Error('Invalid phone'), { statusCode: 400 });

  // Super admin does not need OTP
  if (isSuperAdmin(normalized)) {
    return { success: true, message: 'OTP bypassed', bypassed: true };
  }

  // Environment bypass
  if (!config.sendOtp) {
    logger.info(`OTP bypassed for ${normalized} due to SEND_OTP env var`);
    return { success: true, message: 'OTP bypassed', bypassed: true };
  }

  const otp = smsService.generateOtp();
  smsService.setOtp(normalized, otp);
  await smsService.sendOtp(normalized, otp);
  return { success: true, message: 'OTP sent' };
}

async function verifyOtp(phone, otp, deviceType = 'web', deviceId = '') {
  const normalized = phone.replace(/\D/g, '');
  const superAdmin = isSuperAdmin(normalized);

  // Super admin and disabled OTP bypasses OTP verification
  if (!superAdmin && config.sendOtp) {
    if (!smsService.verifyOtp(normalized, otp)) throw Object.assign(new Error('Invalid or expired OTP'), { statusCode: 400 });
  }

  let user = await User.findOne({ phone: normalized });
  if (!user) {
    user = await User.create({
      phone: normalized,
      name: superAdmin ? 'Super Admin' : normalized,
      role: superAdmin ? 'superadmin' : 'staff',
    });
  } else if (superAdmin && user.role !== 'superadmin') {
    // Ensure existing user is promoted to superadmin
    user.role = 'superadmin';
    user.name = user.name || 'Super Admin';
    await user.save();
  }

  if (!user.isActive) throw Object.assign(new Error('Account disabled'), { statusCode: 403 });
  const loginExpiry = new Date();
  loginExpiry.setDate(loginExpiry.getDate() + SESSION_VALIDITY_DAYS);
  const { accessToken, refreshToken } = generateTokens(user._id);
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 1);
  await Session.create({
    userId: user._id,
    deviceType,
    deviceId,
    refreshToken,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  });
  await User.updateOne({ _id: user._id }, { lastLogin: new Date(), loginExpiry });
  return {
    user: { id: user._id, phone: user.phone, role: user.role, name: user.name, email: user.email },
    accessToken,
    refreshToken,
    expiresIn: 365 * 24 * 3600,
  };
}

async function refresh(refreshToken) {
  if (!refreshToken) throw Object.assign(new Error('Refresh token required'), { statusCode: 400 });
  const session = await Session.findOne({ refreshToken }).populate('userId');
  if (!session || !session.userId) throw Object.assign(new Error('Invalid refresh token'), { statusCode: 401 });
  const user = session.userId;
  if (!user.isActive) throw Object.assign(new Error('Account disabled'), { statusCode: 403 });
  const { accessToken, refreshToken: newRefresh } = generateTokens(user._id);
  session.refreshToken = newRefresh;
  await session.save();
  return { accessToken, refreshToken: newRefresh, expiresIn: 365 * 24 * 3600 };
}

async function logout(userId, refreshToken) {
  if (refreshToken) await Session.deleteOne({ refreshToken });
  else await Session.deleteMany({ userId: userId });
  return { success: true };
}

async function getMe(userId) {
  const user = await User.findById(userId).select('-refreshToken');
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
  return user;
}

module.exports = { sendOtp, verifyOtp, refresh, logout, getMe };
