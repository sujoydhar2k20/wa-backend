const User = require('../models/User');
const Session = require('../models/Session');

async function list({ page, limit, role }) {
  const filter = role ? { role } : {};
  const [users, total] = await Promise.all([
    User.find(filter).select('-refreshToken').skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(filter),
  ]);
  return { users, total, page, limit };
}

async function create(data) {
  const { phone, role, name, email } = data;
  const existing = await User.findOne({ phone });
  if (existing) throw Object.assign(new Error('Phone already registered'), { statusCode: 400 });
  const user = await User.create({ phone, role: role || 'staff', name, email });
  return user.toObject();
}

async function get(id, currentUser) {
  const user = await User.findById(id).select('-refreshToken');
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
  if (currentUser.role !== 'admin' && currentUser._id.toString() !== id) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  return user;
}

async function update(id, data, currentUser) {
  const user = await User.findById(id);
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
  if (currentUser.role !== 'admin' && currentUser._id.toString() !== id) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  const allowed = ['name', 'email'];
  if (currentUser.role === 'admin') allowed.push('role', 'isActive');
  allowed.forEach((k) => { if (data[k] !== undefined) user[k] = data[k]; });
  await user.save();
  return user.toObject();
}

async function remove(id) {
  const user = await User.findById(id);
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
  user.isActive = false;
  await user.save();
  await Session.deleteMany({ userId: id });
  return user.toObject();
}

async function getSessions(userId) {
  const sessions = await Session.find({ userId }).lean();
  return sessions;
}

async function revokeSession(userId, sessionId) {
  await Session.deleteOne({ _id: sessionId, userId: userId });
}

module.exports = { list, create, get, update, remove, getSessions, revokeSession };
