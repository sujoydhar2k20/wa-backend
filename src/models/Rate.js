const mongoose = require('mongoose');

const rateSchema = new mongoose.Schema(
    {
        gold: {
            9: { type: Number, default: 0 },
            14: { type: Number, default: 0 },
            18: { type: Number, default: 0 },
            22: { type: Number, default: 0 },
            24: { type: Number, default: 0 }
        },
        silver: { type: Number, default: 0 },
        diamond: { type: Number, default: 0 }
    },
    { timestamps: true }
);

module.exports = mongoose.model('Rate', rateSchema);
