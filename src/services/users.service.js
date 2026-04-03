const User = require('../models/User');
const Session = require('../models/Session');

async function list({ page, limit, role, wabaId, isActive }) {
  const filter = {};
  if (role) filter.role = role;
  if (wabaId) filter.assignedWabaId = wabaId;
  if (isActive !== undefined) filter.isActive = isActive === 'true' || isActive === true;
  const [users, total] = await Promise.all([
    User.find(filter)
      .select('-refreshToken')
      .populate('assignedWabaId', 'wabaId businessName phoneNumbers')
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);
  return { users, total, page, limit };
}

async function create(data) {
  const { phone, role, name, email, assignedWabaId } = data;
  const existing = await User.findOne({ phone });
  if (existing) throw Object.assign(new Error('Phone already registered'), { statusCode: 400 });
  const user = await User.create({ phone, role: role || 'staff', name, email, assignedWabaId: assignedWabaId || null });
  return user.toObject();
}

async function get(id, currentUser) {
  const user = await User.findById(id).select('-refreshToken').populate('assignedWabaId', 'wabaId businessName phoneNumbers');
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
  if (!['admin', 'superadmin'].includes(currentUser.role) && currentUser._id.toString() !== id) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  return user;
}

async function update(id, data, currentUser) {
  const user = await User.findById(id);
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
  if (!['admin', 'superadmin'].includes(currentUser.role) && currentUser._id.toString() !== id) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  
  const allowed = ['name', 'email'];
  if (['admin', 'superadmin'].includes(currentUser.role)) allowed.push('role', 'isActive', 'assignedWabaId');
  
  const wasActive = user.isActive;
  allowed.forEach((k) => { if (data[k] !== undefined) user[k] = data[k] === '' ? null : data[k]; });
  
  await user.save();
  
  // If the user was deactivated, revoke all their sessions
  if (['admin', 'superadmin'].includes(currentUser.role) && wasActive && !user.isActive) {
    await Session.deleteMany({ userId: id });
  }
  
  return user.toObject();
}

async function remove(id) {
  const user = await User.findById(id);
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
  
  // Delete all sessions for this user
  await Session.deleteMany({ userId: id });
  
  // Delete the user from the database
  await User.findByIdAndDelete(id);
  
  return { _id: id, deleted: true };
}

async function getSessions(userId) {
  const sessions = await Session.find({ userId }).lean();
  return sessions;
}

async function revokeSession(userId, sessionId) {
  await Session.deleteOne({ _id: sessionId, userId: userId });
}

module.exports = { list, create, get, update, remove, getSessions, revokeSession };
