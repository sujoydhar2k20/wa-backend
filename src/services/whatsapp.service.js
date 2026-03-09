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
  let res;
  try {
    res = await axios(opts);
  } catch (error) {
    if (error.response) {
      logger.error(`WhatsApp API Error: ${JSON.stringify(error.response.data)}`);
    } else {
      logger.error(`WhatsApp API Request Error: ${error.message}`);
    }
    throw error;
  }
  return res.data;
}

async function sendTextMessage(wabaId, phoneNumberId, to, text, replyToMessageId = null) {
  const path = `/${phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/\D/g, ''),
    type: 'text',
    text: { body: text },
  };
  if (replyToMessageId) {
    body.context = { message_id: replyToMessageId };
  }
  return request(wabaId, 'POST', path, body);
}

async function sendMediaMessage(wabaId, phoneNumberId, to, type, urlOrId, caption = '', replyToMessageId = null) {
  const path = `/${phoneNumberId}/messages`;
  const key = type === 'document' ? 'document' : type;
  const isId = !urlOrId.startsWith('http');
  const payload = type === 'document'
    ? (isId ? { id: urlOrId, caption } : { link: urlOrId, caption })
    : (isId ? { id: urlOrId, caption: caption || undefined } : { link: urlOrId, caption: caption || undefined });
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/\D/g, ''),
    type,
    [key]: payload,
  };
  if (replyToMessageId) {
    body.context = { message_id: replyToMessageId };
  }
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

async function reactToMessage(wabaId, phoneNumberId, to, messageId, emoji) {
  const path = `/${phoneNumberId}/messages`;
  // According to Meta API, an empty string emoji removes the reaction
  return request(wabaId, 'POST', path, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/\D/g, ''),
    type: 'reaction',
    reaction: { message_id: messageId, emoji: emoji || "" },
  });
}

async function downloadMedia(wabaId, mediaId) {
  const data = await request(wabaId, 'GET', `/${mediaId}`);
  const url = data.url;
  const token = await getAccessToken(wabaId);
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' });
  return res.data;
}

async function uploadMedia(wabaId, phoneNumberId, fileBuffer, mimeType) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fileBuffer, { filename: 'file', contentType: mimeType, knownLength: fileBuffer.length });
  form.append('messaging_product', 'whatsapp');
  const token = await getAccessToken(wabaId);
  const path = `${BASE_URL}/${phoneNumberId}/media`;

  let res;
  try {
    res = await axios.post(path, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    if (error.response) {
      const { logger } = require('../utils/logger');
      logger.error(`Media Upload Error: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
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

async function exchangeEmbeddedSignupCode(code) {
  const url = `${BASE_URL}/oauth/access_token`;
  // When using FB.login() with the JS SDK and response_type: 'code',
  // the redirect_uri must be an empty string.
  console.log('[DEBUG] exchangeEmbeddedSignupCode:', { code: code?.substring(0, 30) + '...' });
  const res = await axios.get(url, {
    params: {
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      code,
      redirect_uri: '',
    }
  });
  return res.data;
}

async function getWabasFromToken(inputToken) {
  const url = `${BASE_URL}/debug_token`;
  const appAccessToken = `${config.meta.appId}|${config.meta.appSecret}`;
  const res = await axios.get(url, {
    params: {
      input_token: inputToken,
      access_token: appAccessToken,
    }
  });

  const granularScopes = res.data.data.granular_scopes || [];
  const wabaScope = granularScopes.find(s => s.scope === 'whatsapp_business_management');
  const messagingScope = granularScopes.find(s => s.scope === 'whatsapp_business_messaging');

  const wabaIds = wabaScope?.target_ids || [];
  const phoneIds = messagingScope?.target_ids || [];

  return { wabaIds, phoneIds };
}

async function getWabaDetails(wabaId, accessToken) {
  const url = `${BASE_URL}/${wabaId}`;
  const res = await axios.get(url, {
    params: {
      fields: 'id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}',
      access_token: accessToken,
    }
  });
  return res.data;
}

/**
 * Set data localization (storage configuration) for a phone number.
 * Must be called BEFORE registerPhoneNumber() for migrated numbers
 * in regions that require data localization (e.g. India → 'in').
 *
 * Official Meta docs format:
 *   POST /{PHONE_NUMBER_ID}/settings
 *   { "storage_configuration": { "enabled": true, "region": "in" } }
 */
async function setStorageConfiguration(phoneNumberId, region, accessToken) {
  const url = `${BASE_URL}/${phoneNumberId}/settings`;
  const res = await axios.post(url, {
    storage_configuration: {
      enabled: true,
      region: region.toLowerCase()
    }
  }, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  return res.data;
}

async function registerPhoneNumber(phoneNumberId, pin, accessToken) {
  const url = `${BASE_URL}/${phoneNumberId}/register`;
  const body = {
    messaging_product: 'whatsapp',
    pin: pin
  };
  const res = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  return res.data;
}

async function subscribeAppToWaba(wabaId, accessToken) {
  const url = `${BASE_URL}/${wabaId}/subscribed_apps`;
  const res = await axios.post(url, {}, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  return res.data;
}

/**
 * Exchange a short-lived FB JS SDK token for a long-lived user token (~60 days).
 * Always call this before storing any token from embedded signup.
 */
async function getLongLivedToken(shortLivedToken) {
  const url = `https://graph.facebook.com/oauth/access_token`;
  const res = await axios.get(url, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      fb_exchange_token: shortLivedToken,
    }
  });
  // Returns { access_token, token_type, expires_in }
  return res.data.access_token;
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
  exchangeEmbeddedSignupCode,
  getLongLivedToken,
  getWabasFromToken,
  getWabaDetails,
  setStorageConfiguration,
  registerPhoneNumber,
  subscribeAppToWaba,
};
