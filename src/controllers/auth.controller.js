const authService = require('../services/auth.service');

async function sendOtp(req, res, next) {
  try {
    const { phone } = req.body;
    const result = await authService.sendOtp(phone);
    res.json(result);
  } catch (e) {
    next(e);
  }
}

async function verifyOtp(req, res, next) {
  try {
    const { phone, otp, deviceType, deviceId } = req.body;
    const result = await authService.verifyOtp(phone, otp, deviceType, deviceId);
    res.json(result);
  } catch (e) {
    next(e);
  }
}

async function refresh(req, res, next) {
  try {
    const refreshToken = req.body.refreshToken || req.headers['x-refresh-token'];
    const result = await authService.refresh(refreshToken);
    res.json(result);
  } catch (e) {
    next(e);
  }
}

async function logout(req, res, next) {
  try {
    const refreshToken = req.body.refreshToken || req.headers['x-refresh-token'];
    await authService.logout(req.user?._id, refreshToken);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
}

async function me(req, res, next) {
  try {
    const user = await authService.getMe(req.user._id);
    res.json(user);
  } catch (e) {
    next(e);
  }
}

module.exports = { sendOtp, verifyOtp, refresh, logout, me };
