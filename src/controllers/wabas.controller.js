const { Waba, Template } = require('../models');
const whatsappService = require('../services/whatsapp.service');

async function list(req, res, next) {
    try {
        const wabas = await Waba.find().sort({ createdAt: -1 });
        res.json(wabas);
    } catch (e) {
        next(e);
    }
}

async function create(req, res, next) {
    try {
        const waba = new Waba(req.body);
        await waba.save();
        res.status(201).json(waba);
    } catch (e) {
        next(e);
    }
}

async function get(req, res, next) {
    try {
        const waba = await Waba.findById(req.params.id);
        if (!waba) {
            return res.status(404).json({ success: false, message: 'WABA not found' });
        }
        res.json(waba);
    } catch (e) {
        next(e);
    }
}

async function update(req, res, next) {
    try {
        const waba = await Waba.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!waba) {
            return res.status(404).json({ success: false, message: 'WABA not found' });
        }
        res.json(waba);
    } catch (e) {
        next(e);
    }
}

async function syncTemplates(req, res, next) {
    try {
        const templates = await whatsappService.syncTemplates(req.params.id);
        res.json({ success: true, count: templates.length });
    } catch (e) {
        next(e);
    }
}

async function getTemplates(req, res, next) {
    try {
        const templates = await Template.find({ wabaId: req.params.id }).sort({ name: 1 });
        res.json(templates);
    } catch (e) {
        next(e);
    }
}

module.exports = {
    list,
    create,
    get,
    update,
    syncTemplates,
    getTemplates,
};
