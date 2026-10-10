const callService = require('../services/call.service');
const { Chat } = require('../models');
const { logger } = require('../utils/logger');

/**
 * POST /api/calls/:chatId/request-permission
 * Send a call permission request to the customer.
 */
async function requestPermission(req, res, next) {
  try {
    const { chatId } = req.params;
    const chat = await Chat.findById(chatId).populate('wabaId');
    if (!chat) return res.status(404).json({ success: false, error: 'Chat not found' });

    const waba = chat.wabaId;
    const phoneNumberId = chat.phoneNumberId || waba.phoneNumbers?.[0]?.phoneNumberId;
    if (!phoneNumberId) {
      return res.status(400).json({ success: false, error: 'No phone number ID available for this chat' });
    }

    const callLog = await callService.requestCallPermission(
      waba._id,
      phoneNumberId,
      chat.waId,
      req.user._id
    );

    res.json({ success: true, callLog });
  } catch (error) {
    logger.error('Request call permission error:', error.message);
    if (error.response?.data) {
      return res.status(error.response.status || 500).json({
        success: false,
        error: error.response.data?.error?.message || 'Failed to request call permission',
      });
    }
    next(error);
  }
}

/**
 * POST /api/calls/:chatId/initiate
 * Start an outbound call to the customer.
 */
async function initiateCallHandler(req, res, next) {
  try {
    const { chatId } = req.params;
    const chat = await Chat.findById(chatId).populate('wabaId');
    if (!chat) return res.status(404).json({ success: false, error: 'Chat not found' });

    const waba = chat.wabaId;
    const phoneNumberId = chat.phoneNumberId || waba.phoneNumbers?.[0]?.phoneNumberId;
    if (!phoneNumberId) {
      return res.status(400).json({ success: false, error: 'No phone number ID available for this chat' });
    }

    const callLog = await callService.initiateCall(
      waba._id,
      phoneNumberId,
      chat.waId,
      req.user._id
    );

    res.json({ success: true, callLog });
  } catch (error) {
    logger.error('Initiate call error:', error.message);
    if (error.response?.data) {
      return res.status(error.response.status || 500).json({
        success: false,
        error: error.response.data?.error?.message || 'Failed to initiate call',
      });
    }
    next(error);
  }
}

/**
 * POST /api/calls/:callLogId/terminate
 * End an active call.
 */
async function terminateCallHandler(req, res, next) {
  try {
    const { callLogId } = req.params;
    const { CallLog } = require('../models');
    const callLog = await CallLog.findById(callLogId);
    if (!callLog) return res.status(404).json({ success: false, error: 'Call log not found' });
    if (!callLog.callId) return res.status(400).json({ success: false, error: 'No active call ID to terminate' });

    const result = await callService.terminateCall(
      callLog.wabaId,
      callLog.phoneNumberId,
      callLog.callId
    );

    res.json({ success: true, callLog: result });
  } catch (error) {
    logger.error('Terminate call error:', error.message);
    if (error.response?.data) {
      return res.status(error.response.status || 500).json({
        success: false,
        error: error.response.data?.error?.message || 'Failed to terminate call',
      });
    }
    next(error);
  }
}

/**
 * GET /api/calls/:chatId/logs
 * Get call history for a specific chat.
 */
async function getChatCallLogs(req, res, next) {
  try {
    const { chatId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const result = await callService.getCallLogsByChat(chatId, {
      page: parseInt(page),
      limit: parseInt(limit),
    });

    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Get call logs error:', error.message);
    next(error);
  }
}

/**
 * GET /api/calls/logs
 * Get all call logs (admin).
 */
async function getAllCallLogs(req, res, next) {
  try {
    const { page = 1, limit = 50, wabaId, direction, status } = req.query;

    const result = await callService.getAllCallLogs({
      page: parseInt(page),
      limit: parseInt(limit),
      wabaId,
      direction,
      status,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Get all call logs error:', error.message);
    next(error);
  }
}

module.exports = {
  requestPermission,
  initiateCall: initiateCallHandler,
  terminateCall: terminateCallHandler,
  getChatCallLogs,
  getAllCallLogs,
};
