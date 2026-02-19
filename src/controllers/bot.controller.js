const { BotFlow, BotExecution } = require('../models');

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
        const flow = new BotFlow({ ...req.body, createdBy: req.user._id });
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
        const flow = await BotFlow.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
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
            { new: true }
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
            { new: true }
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
