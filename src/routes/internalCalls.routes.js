'use strict';

/**
 * Private endpoints called by the Asterisk dialplan (func_curl, form-encoded POST).
 * Replies are plain text so the dialplan can parse them with CUT().
 */
const express = require('express');
const { internalAuth } = require('../middleware/internalAuth');
const flow = require('../services/calls/callFlow');
const { logger } = require('../utils/logger');

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '10kb' }));
router.use(internalAuth);

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req.body || {});
    res.type('text/plain').send(String(out ?? 'ok'));
  } catch (e) {
    logger.error(`[calls] internal ${req.path} failed: ${e.message}`);
    res.status(200).type('text/plain').send('error');
  }
};

router.post('/inbound-route', wrap((b) => flow.inboundRoute({ uniqueid: b.uniqueid, wacid: b.wacid, from: b.from, to: b.to })));
router.post('/stage-all', wrap((b) => flow.stageAll({ callLogId: b.callLogId })));
router.post('/answered', wrap((b) => flow.answered({ callLogId: b.callLogId, endpoint: b.endpoint })));
router.post('/hangup', wrap((b) => flow.hangup({ callLogId: b.callLogId, dialstatus: b.dialstatus, answeredtime: b.answeredtime, recfile: b.recfile, cause: b.cause })));
router.post('/outbound-authorize', wrap((b) => flow.authorizeOutbound({ endpoint: b.endpoint, target: b.target, uniqueid: b.uniqueid })));

module.exports = router;
