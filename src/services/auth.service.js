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

async function sendOtp(phone) {
  const normalized = phone.replace(/\D/g, '');
  if (!normalized) throw Object.assign(new Error('Invalid phone'), { statusCode: 400 });

  // OTP is mandatory for every role. There is no bypass, no environment switch and no
  // special-cased phone number. Only Indian numbers of registered, active users may receive an OTP.
  const isIndianNumber = normalized.length === 10 || (normalized.length === 12 && normalized.startsWith('91'));
  if (!isIndianNumber) {
    throw Object.assign(new Error('OTP can only be sent to Indian numbers'), { statusCode: 400 });
  }

  // Only allow existing staff/admins to receive OTPs
  const userExists = await User.exists({ phone: normalized });
  if (!userExists) {
    throw Object.assign(new Error('Account not found. Please ask an administrator to register your number.'), { statusCode: 404 });
  }

  const otp = smsService.generateOtp();
  smsService.setOtp(normalized, otp);
  await smsService.sendOtp(normalized, otp);
  return { success: true, message: 'OTP sent' };
}

async function verifyOtp(phone, otp, deviceType = 'web', deviceId = '') {
  const normalized = phone.replace(/\D/g, '');
  const isIndianNumber = normalized.length === 10 || (normalized.length === 12 && normalized.startsWith('91'));
  if (!isIndianNumber) {
    throw Object.assign(new Error('Only Indian numbers are allowed'), { statusCode: 400 });
  }

  // OTP verification is mandatory for every role (no bypass of any kind).
  if (!smsService.verifyOtp(normalized, otp)) {
    throw Object.assign(new Error('Invalid or expired OTP'), { statusCode: 400 });
  }

  // Accounts are never created or promoted at login. Users (and their roles) are managed by
  // administrators or the create-superadmin script.
  const user = await User.findOne({ phone: normalized });
  if (!user) {
    throw Object.assign(new Error('Account not found. Please ask an administrator to register your number.'), { statusCode: 404 });
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
    user: { 
      id: user._id, 
      phone: user.phone, 
      role: user.role, 
      name: user.name, 
      email: user.email,
      profilePicture: user.profilePicture || null,
      primaryChannel: user.primaryChannel || null,
      isDnd: !!user.isDnd
    },
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
