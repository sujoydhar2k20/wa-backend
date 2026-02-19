const axios = require('axios');
const Waba = require('../models/Waba');
const Template = require('../models/Template');
const config = require('../config');
const { logger } = require('../utils/logger');

const BASE_URL = `https://graph.facebook.com/${config.meta.apiVersion}`;

async function getWaba(wabaId) {
  const waba = await Waba.findById(wabaId);
  if (!waba) throw new Error('WABA not found');
  return waba;
}

async function getAccessToken(wabaId) {
  const waba = await getWaba(wabaId);
  return waba.accessToken;
}

async function request(wabaId, method, path, data = null) {
  const token = await getAccessToken(wabaId);
  const url = `${BASE_URL}${path}`;
  const opts = { method, url, headers: { Authorization: `Bearer ${token}` } };
  if (data) opts.data = data;
  const res = await axios(opts);
  return res.data;
}

async function sendTextMessage(wabaId, phoneNumberId, to, text) {
  const path = `/${phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/\D/g, ''),
    type: 'text',
    text: { body: text },
  };
  return request(wabaId, 'POST', path, body);
}

async function sendMediaMessage(wabaId, phoneNumberId, to, type, urlOrId, caption = '') {
  const path = `/${phoneNumberId}/messages`;
  const key = type === 'document' ? 'document' : type;
  const payload = type === 'document' ? { link: urlOrId, caption } : { link: urlOrId, caption: caption || undefined };
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/\D/g, ''),
    type,
    [key]: payload,
  };
  return request(wabaId, 'POST', path, body);
}

async function sendTemplateMessage(wabaId, phoneNumberId, to, templateName, language = 'en', components = []) {
  const path = `/${phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/\D/g, ''),
    type: 'template',
    template: { name: templateName, language: { code: language }, components: components.length ? components : undefined },
  };
  return request(wabaId, 'POST', path, body);
}

async function sendInteractiveMessage(wabaId, phoneNumberId, to, interactivePayload) {
  const path = `/${phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/\D/g, ''),
    type: 'interactive',
    interactive: interactivePayload,
  };
  return request(wabaId, 'POST', path, body);
}

async function markMessageAsRead(wabaId, messageId) {
  const waba = await getWaba(wabaId);
  const phoneNumberId = waba.phoneNumbers?.[0]?.phoneNumberId;
  if (!phoneNumberId) return;
  const path = `/${phoneNumberId}/messages`;
  await request(wabaId, 'POST', path, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  });
}

async function reactToMessage(wabaId, messageId, emoji) {
  const waba = await getWaba(wabaId);
  const phoneNumberId = waba.phoneNumbers?.[0]?.phoneNumberId;
  if (!phoneNumberId) throw new Error('No phone number');
  const path = `/${phoneNumberId}/messages`;
  return request(wabaId, 'POST', path, {
    messaging_product: 'whatsapp',
    type: 'reaction',
    reaction: { message_id: messageId, emoji },
  });
}

async function downloadMedia(wabaId, mediaId) {
  const data = await request(wabaId, 'GET', `/${mediaId}`);
  const url = data.url;
  const token = await getAccessToken(wabaId);
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' });
  return res.data;
}

async function uploadMedia(wabaId, type, fileBuffer, mimeType) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fileBuffer, { filename: 'file', contentType: mimeType });
  const token = await getAccessToken(wabaId);
  const path = `${BASE_URL}/${wabaId}/media`;
  const res = await axios.post(path, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
  });
  return res.data.id;
}

async function syncTemplates(wabaId) {
  const waba = await getWaba(wabaId);
  const wabaMetaId = waba.wabaId;
  const data = await request(wabaId, 'GET', `/${wabaMetaId}/message_templates`);
  const templates = data.data || [];
  for (const t of templates) {
    await Template.findOneAndUpdate(
      { wabaId, name: t.name, language: t.language },
      {
        wabaId,
        templateId: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        components: t.components,
        metaData: t,
      },
      { upsert: true, new: true }
    );
  }
  logger.info(`Synced ${templates.length} templates for WABA ${wabaId}`);
  return templates;
}

function verifyWebhook(mode, token, challenge) {
  const verifyToken = config.meta.webhookVerifyToken;
  if (mode === 'subscribe' && token === verifyToken) return challenge;
  return null;
}

module.exports = {
  getWaba,
  getAccessToken,
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveMessage,
  markMessageAsRead,
  reactToMessage,
  downloadMedia,
  uploadMedia,
  syncTemplates,
  verifyWebhook,
  request,
};
