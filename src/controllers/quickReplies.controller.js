const { QuickReply } = require('../models');

async function list(req, res, next) {
  try {
    const query = {
      $or: [
        { visibility: 'everyone' },
        { userId: req.user._id }
      ]
    };

    // If user has an assigned WABA, show that WABA's replies AND global ones.
    // Super-admin "everyone" replies are saved with no wabaId (global, since super admins
    // have no assignedWabaId); without including null here, staff would never see them.
    if (req.user.assignedWabaId) {
      query.wabaId = { $in: [req.user.assignedWabaId, null] };
    }

    const quickReplies = await QuickReply.find(query).sort({ shortcut: 1 });
    res.json(quickReplies);
  } catch (e) {
    next(e);
  }
}

async function create(req, res, next) {
  try {
    const { shortcut, message, mediaUrl, mediaType, visibility, wabaId } = req.body;
    
    if (!shortcut || !message) {
      return res.status(400).json({ success: false, message: 'shortcut and message are required' });
    }

    const quickReply = new QuickReply({
      shortcut,
      message,
      mediaUrl,
      mediaType,
      visibility: visibility || 'everyone',
      userId: req.user._id,
      wabaId: wabaId || req.user.assignedWabaId
    });

    await quickReply.save();
    res.status(201).json(quickReply);
  } catch (e) {
    if (e.code === 11000) {
      return res.status(400).json({ success: false, message: 'Shortcut already exists for this scope' });
    }
    next(e);
  }
}

async function update(req, res, next) {
  try {
    const quickReply = await QuickReply.findById(req.params.id);
    if (!quickReply) {
      return res.status(404).json({ success: false, message: 'Quick reply not found' });
    }

    // Only creator can edit their 'me' replies
    if (quickReply.visibility === 'me' && quickReply.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Permission denied' });
    }

    Object.assign(quickReply, req.body);
    await quickReply.save();
    
    res.json(quickReply);
  } catch (e) {
    if (e.code === 11000) {
      return res.status(400).json({ success: false, message: 'Shortcut already exists for this scope' });
    }
    next(e);
  }
}

async function remove(req, res, next) {
  try {
    const quickReply = await QuickReply.findById(req.params.id);
    if (!quickReply) {
      return res.status(404).json({ success: false, message: 'Quick reply not found' });
    }

    // Only creator or admin can delete
    if (quickReply.userId.toString() !== req.user._id.toString() && !['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Permission denied' });
    }

    await QuickReply.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
}

module.exports = { list, create, update, remove };
