#!/usr/bin/env node
/**
 * Local end-to-end harness for the media pipeline (NEVER for production):
 *   - throwaway in-memory MongoDB (mongodb-memory-server)
 *   - the real backend (server.js) on E2E_PORT (default 5055)
 *   - a fake Meta Graph API on 5057 (axios calls to graph.facebook.com are redirected there)
 *   - a static server on 5056 standing in for upload.biswakarmagold.com
 *   - seed data: one admin user, one WABA, one customer chat; writes e2e-session.json (token, ids)
 * Control the fake Meta API with POST http://127.0.0.1:5057/__control
 *   { "sendDelayMs": 2500, "uploadDelayMs": 0, "failCaption": "FAIL-ME" }
 * and read what it received with GET /__log.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.E2E_PORT || 5055);
const VPS_PORT = 5056;
const GRAPH_PORT = 5057;
const vpsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-vps-'));
const out = process.env.E2E_SESSION_FILE || path.join(os.tmpdir(), 'e2e-session.json');

process.env.PORT = String(PORT);
process.env.JWT_SECRET = 'e2e-secret-'.repeat(4);
process.env.META_APP_SECRET = 'e2e-app-secret';
process.env.VPS_UPLOAD_DIR = vpsDir;
process.env.VPS_UPLOAD_URL = `http://127.0.0.1:${VPS_PORT}`;
process.env.CORS_ORIGIN = 'http://127.0.0.1:3004,http://localhost:3004';
process.env.NODE_ENV = 'development';

// ---- fake Meta Graph API --------------------------------------------------------------------------
const control = { sendDelayMs: 2500, uploadDelayMs: 0, failCaption: 'FAIL-ME', failOnce: true };
const log = [];
let n = 0;
http.createServer((req, res) => {
  const chunks = [];
  let bytes = 0;
  req.on('data', (c) => { bytes += c.length; if (chunks.length < 4) chunks.push(c); });
  req.on('end', async () => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/__control' && req.method === 'POST') {
      Object.assign(control, JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      return send(200, control);
    }
    if (req.url === '/__log') return send(200, log);
    if (/\/media$/.test(req.url) && req.method === 'POST') {
      await new Promise((r) => setTimeout(r, control.uploadDelayMs));
      n += 1;
      log.push({ kind: 'upload', at: Date.now(), bytes, contentLength: Number(req.headers['content-length']) });
      return send(200, { id: `E2E-MEDIA-${n}` });
    }
    if (/\/messages$/.test(req.url) && req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const media = body[body.type] || {};
      log.push({ kind: 'send', at: Date.now(), type: body.type, caption: media.caption, id: media.id, opaque: body.biz_opaque_callback_data, text: body.text?.body });
      if (control.failCaption && media.caption === control.failCaption && control.failOnce !== 'used') {
        if (control.failOnce) control.failOnce = 'used';
        return send(400, { error: { code: 131053, message: 'Media upload error (simulated by the E2E fake)' } });
      }
      if (body.type !== 'text') await new Promise((r) => setTimeout(r, control.sendDelayMs));
      n += 1;
      return send(200, { messages: [{ id: `wamid.E2E${n}` }] });
    }
    return send(200, {});
  });
}).listen(GRAPH_PORT, '127.0.0.1');

// Redirect the backend's Meta calls to the fake (only in this harness process).
const axios = require('axios');
axios.interceptors.request.use((cfg) => {
  if (cfg.url && cfg.url.startsWith('https://graph.facebook.com')) {
    cfg.url = cfg.url.replace(/^https:\/\/graph\.facebook\.com/, `http://127.0.0.1:${GRAPH_PORT}`);
  }
  return cfg;
});

// ---- stand-in for the public upload host -----------------------------------------------------------
const express = require('express');
const vps = express();
vps.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
vps.use(express.static(vpsDir));
vps.listen(VPS_PORT, '127.0.0.1');

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongo = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  process.env.MONGODB_URI = mongo.getUri('whatsapp-e2e');

  require('../../server.js'); // starts DB connection, socket.io, Agenda, HTTP

  const mongoose = require('mongoose');
  await new Promise((r) => (mongoose.connection.readyState === 1 ? r() : mongoose.connection.once('open', r)));
  const { User, Waba, Contact, Chat } = require('../../src/models');
  const user = await User.create({ name: 'E2E Admin', phone: '919999900000', role: 'admin', isActive: true });
  const waba = await Waba.create({ wabaId: 'W-E2E', businessName: 'BJS E2E', accessToken: 'e2e-token', phoneNumbers: [{ phoneNumberId: 'pn-e2e', phoneNumber: '919000000000' }] });
  const contact = await Contact.create({ phoneNumber: '919800000077', waId: '919800000077', name: 'Test Customer' });
  const chat = await Chat.create({
    wabaId: waba._id, phoneNumberId: 'pn-e2e', phoneNumber: '919800000077', waId: '919800000077', contactId: contact._id,
    assignedTo: user._id, sessionExpiresAt: new Date(Date.now() + 20 * 3600e3), status: 'open',
  });
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ userId: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '2h' });
  fs.writeFileSync(out, JSON.stringify({
    token, chatId: String(chat._id), user: { _id: String(user._id), name: user.name, phone: user.phone, role: user.role, isActive: true },
    api: `http://127.0.0.1:${PORT}`, graph: `http://127.0.0.1:${GRAPH_PORT}`, vpsDir,
  }, null, 2));
  console.log(`[e2e] backend ready on ${PORT}; session written to ${out}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
