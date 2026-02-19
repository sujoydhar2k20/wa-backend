const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const decoded = jwt.verify(token, config.jwt.secret);
    const user = await User.findById(decoded.userId).select('-refreshToken');
    if (!user || !user.isActive) return res.status(401).json({ success: false, message: 'Unauthorized' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
}

function requireAdmin(req, res, next) {
  if (!['admin', 'superadmin'].includes(req.user?.role)) return res.status(403).json({ success: false, message: 'Forbidden' });
  next();
}

function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ success: false, message: 'Forbidden' });
  next();
}

module.exports = { authenticate, requireAdmin, requireSuperAdmin };
