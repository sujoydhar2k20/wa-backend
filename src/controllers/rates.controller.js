const { Rate } = require('../models');

async function getRates(req, res, next) {
    try {
        let rate = await Rate.findOne();
        if (!rate) {
            rate = new Rate();
            await rate.save();
        }
        res.json(rate);
    } catch (e) {
        next(e);
    }
}

async function updateRates(req, res, next) {
    try {
        let rate = await Rate.findOne();
        if (!rate) {
            rate = new Rate(req.body);
        } else {
            Object.assign(rate, req.body);
        }
        await rate.save();
        res.json(rate);
    } catch (e) {
        next(e);
    }
}

module.exports = {
    getRates,
    updateRates
};
