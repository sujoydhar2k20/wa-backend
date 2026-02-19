const usersService = require('../services/users.service');

async function list(req, res, next) {
  try {
    const { page = 1, limit = 20, role } = req.query;
    const result = await usersService.list({ page: parseInt(page, 10), limit: parseInt(limit, 10), role });
    res.json(result);
  } catch (e) {
    next(e);
  }
}

async function create(req, res, next) {
  try {
    const user = await usersService.create(req.body);
    res.status(201).json(user);
  } catch (e) {
    next(e);
  }
}

async function get(req, res, next) {
  try {
    const user = await usersService.get(req.params.id, req.user);
    res.json(user);
  } catch (e) {
    next(e);
  }
}

async function update(req, res, next) {
  try {
    const user = await usersService.update(req.params.id, req.body, req.user);
    res.json(user);
  } catch (e) {
    next(e);
  }
}

async function remove(req, res, next) {
  try {
    await usersService.remove(req.params.id);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
}

async function getSessions(req, res, next) {
  try {
    const sessions = await usersService.getSessions(req.params.id);
    res.json(sessions);
  } catch (e) {
    next(e);
  }
}

async function revokeSession(req, res, next) {
  try {
    await usersService.revokeSession(req.params.id, req.params.sessionId);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
}

module.exports = { list, create, get, update, remove, getSessions, revokeSession };
