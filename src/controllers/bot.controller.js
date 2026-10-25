const mongoose = require('mongoose');
const { BotFlow, BotExecution, Waba } = require('../models');

/**
 * Clean a flow body from the editor: never let the client overwrite ownership/ids, and
 * normalise the WhatsApp number (wabaId): '', 'all' or null = all numbers.
 * Throws a 400-style error for an unknown account.
 */
async function sanitizeFlowBody(body = {}) {
    const { _id, createdBy, createdAt, updatedAt, __v, ...clean } = body;
    if (Object.prototype.hasOwnProperty.call(clean, 'wabaId')) {
        const raw = clean.wabaId && typeof clean.wabaId === 'object' ? clean.wabaId._id : clean.wabaId;
        if (!raw || raw === 'all') {
            clean.wabaId = null;
        } else {
            if (!mongoose.isValidObjectId(raw) || !(await Waba.exists({ _id: raw }))) {
                const err = new Error('Unknown WhatsApp account for this bot');
                err.status = 400;
                throw err;
            }
            clean.wabaId = raw;
        }
    }
    return clean;
}

function sendBadRequest(res, e) {
    return res.status(400).json({ success: false, message: e.message });
}

async function listFlows(req, res, next) {
    try {
        const { page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const [flows, total] = await Promise.all([
            BotFlow.find().sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit, 10)),
            BotFlow.countDocuments(),
        ]);
        res.json({ data: flows, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

async function createFlow(req, res, next) {
    try {
        let body;
        try { body = await sanitizeFlowBody(req.body); } catch (e) { return sendBadRequest(res, e); }
        const flow = new BotFlow({ ...body, createdBy: req.user._id });
        await flow.save();
        res.status(201).json(flow);
    } catch (e) {
        next(e);
    }
}

async function getFlow(req, res, next) {
    try {
        const flow = await BotFlow.findById(req.params.id);
        if (!flow) return res.status(404).json({ success: false, message: 'Flow not found' });
        res.json(flow);
    } catch (e) {
        next(e);
    }
}

async function updateFlow(req, res, next) {
    try {
        let body;
        try { body = await sanitizeFlowBody(req.body); } catch (e) { return sendBadRequest(res, e); }
        const flow = await BotFlow.findByIdAndUpdate(
            req.params.id,
            body,
            { returnDocument: 'after', runValidators: true }
        );
        if (!flow) return res.status(404).json({ success: false, message: 'Flow not found' });
        res.json(flow);
    } catch (e) {
        next(e);
    }
}

async function removeFlow(req, res, next) {
    try {
        const flow = await BotFlow.findByIdAndDelete(req.params.id);
        if (!flow) return res.status(404).json({ success: false, message: 'Flow not found' });
        res.json({ success: true });
    } catch (e) {
        next(e);
    }
}

async function enable(req, res, next) {
    try {
        const flow = await BotFlow.findByIdAndUpdate(
            req.params.id,
            { isEnabled: true },
            { returnDocument: 'after' }
        );
        if (!flow) return res.status(404).json({ success: false, message: 'Flow not found' });
        res.json(flow);
    } catch (e) {
        next(e);
    }
}

async function disable(req, res, next) {
    try {
        const flow = await BotFlow.findByIdAndUpdate(
            req.params.id,
            { isEnabled: false },
            { returnDocument: 'after' }
        );
        if (!flow) return res.status(404).json({ success: false, message: 'Flow not found' });
        res.json(flow);
    } catch (e) {
        next(e);
    }
}

async function getExecutions(req, res, next) {
    try {
        const { page = 1, limit = 20, status } = req.query;
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const filter = { flowId: req.params.id };
        if (status) filter.status = status;
        const [executions, total] = await Promise.all([
            BotExecution.find(filter)
                .sort({ startedAt: -1 })
                .skip(skip)
                .limit(parseInt(limit, 10))
                .populate('chatId', 'phoneNumber waId'),
            BotExecution.countDocuments(filter),
        ]);
        res.json({ data: executions, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
    } catch (e) {
        next(e);
    }
}

module.exports = {
    listFlows,
    createFlow,
    getFlow,
    updateFlow,
    removeFlow,
    enable,
    disable,
    getExecutions,
};
