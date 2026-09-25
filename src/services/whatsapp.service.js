const axios = require('axios');
const Waba = require('../models/Waba');
const Template = require('../models/Template');
const Contact = require('../models/Contact');
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

/**
 * Guard: check if the recipient contact is blocked or opted-out.
 * Throws a 403-status error if so, preventing the Meta API call.
 * Silently passes through if the contact is not found in the DB
 * (e.g. first outbound to an unknown number).
 */
async function checkContactBlockedOrOptedOut(to) {
  const sanitized = to.replace(/\D/g, '');
  const contact = await Contact.findOne({
    $or: [{ waId: sanitized }, { phoneNumber: sanitized }]
  }).select('isBlocked isOptedOut').lean();
  if (contact && (contact.isBlocked || contact.isOptedOut)) {
    const reason = contact.isBlocked ? 'blocked' : 'opted-out';
    const err = new Error(`Cannot send messages to ${reason} contacts.`);
    err.statusCode = 403;
    throw err;
  }
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
      const metaMsg = error.response.data?.error?.message;
      if (metaMsg) {
        error.message = `Meta API Error: ${metaMsg}`;
        error.statusCode = error.response.status || 400;
      }
    } else {
      logger.error(`WhatsApp API Request Error: ${error.message}`);
    }
    throw error;
  }
  return res.data;
}

async function sendTextMessage(wabaId, phoneNumberId, to, text, replyToMessageId = null) {
  await checkContactBlockedOrOptedOut(to);
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
  await checkContactBlockedOrOptedOut(to);
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

// Meta keeps uploaded media for 30 days. Re-upload well before that.
const META_MEDIA_MAX_AGE_MS = 25 * 24 * 60 * 60 * 1000;

function isCachedMediaIdFresh(headerComponent) {
  if (!headerComponent.imageMediaId) return false;
  const uploadedAt = headerComponent.imageMediaIdUploadedAt;
  // Legacy IDs without a timestamp have unknown age -> treat as stale, re-upload once.
  if (!uploadedAt) return false;
  return Date.now() - new Date(uploadedAt).getTime() < META_MEDIA_MAX_AGE_MS;
}

function isMetaMediaMissingError(error) {
  const err = error?.response?.data?.error;
  if (!err) return false;
  const details = `${err.error_data?.details || ''} ${err.message || ''}`.toLowerCase();
  return err.code === 131009 && /media/.test(details) && /(does not exist|expired)/.test(details);
}

/**
 * Store a stable copy of a template header image on our own storage so staff can
 * see it in the chat. Meta's example/CDN URLs are signed and expire, so they can't
 * be used for display. Best effort: never blocks sending.
 */
async function hostTemplateHeaderImage(templateDoc, headerComponent, buffer, mimeType, source = 'meta_sample') {
  try {
    const { uploadToVPS } = require('../utils/vpsUpload');
    const url = await uploadToVPS(buffer, {
      folder: 'template-headers',
      publicId: `${templateDoc._id}_${Date.now()}`,
      mimeType,
    });
    headerComponent.hostedImageUrl = url;
    headerComponent.imageSource = source;
    templateDoc.markModified('components');
    await templateDoc.save();
    return url;
  } catch (err) {
    logger.warn(`Could not host template header image for ${templateDoc.name}: ${err.message}`);
    return null;
  }
}

async function ensureTemplateHeaderImageMediaId(wabaId, phoneNumberId, templateDoc, headerComponent, forceRefresh = false) {
  if (!forceRefresh && isCachedMediaIdFresh(headerComponent)) {
    // Backfill a hosted display copy for templates cached before hosting existed (best effort).
    if (!headerComponent.hostedImageUrl && headerComponent.imageUrl) {
      try {
        const r = await axios.get(headerComponent.imageUrl, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WhatsApp-Template-Cache/1.0)' } });
        const buf = Buffer.from(r.data);
        if (buf.length) await hostTemplateHeaderImage(templateDoc, headerComponent, buf, (r.headers['content-type'] || 'image/jpeg').split(';')[0].trim());
      } catch (err) {
        logger.warn(`Template ${templateDoc.name}: could not backfill hosted header image: ${err.message}`);
      }
    }
    return headerComponent.imageMediaId;
  }
  // Re-upload from OUR hosted copy first (it is the staff's custom image when they uploaded one).
  // Falling back to Meta's sample URL would silently replace a custom image with the sample.
  const usingHostedSource = !!headerComponent.hostedImageUrl;
  const sourceUrl = headerComponent.hostedImageUrl || headerComponent.imageUrl;
  if (!sourceUrl) {
    // No source to re-upload from; a stale/expired ID would only make Meta reject the send.
    if (headerComponent.imageMediaId) {
      logger.warn(`Template ${templateDoc.name}: cached media ID is stale and no image source exists to re-upload. Upload a header image again.`);
    }
    return null;
  }

  logger.info(`Caching template header image as Meta media for ${templateDoc.name}`);

  let response;
  try {
    response = await axios.get(sourceUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WhatsApp-Template-Cache/1.0)',
      },
      maxRedirects: 5,
    });
  } catch (error) {
    logger.error(`Failed to download template header image for ${templateDoc.name}: ${error.message}`);
    throw new Error('Template image is not usable for delivery. Upload a custom header image and try again.');
  }

  const imageBuffer = Buffer.from(response.data);
  if (!imageBuffer.length) {
    throw new Error('Template image download returned empty data. Upload a custom header image and try again.');
  }

  const mimeType = (response.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
  const mediaId = await uploadMedia(wabaId, phoneNumberId, imageBuffer, mimeType);

  if (!usingHostedSource) await hostTemplateHeaderImage(templateDoc, headerComponent, imageBuffer, mimeType, 'meta_sample');

  headerComponent.imageMediaId = mediaId;
  headerComponent.imageMediaIdUploadedAt = new Date();
  templateDoc.markModified('components');
  await templateDoc.save();

  logger.info(`Cached template header image media for ${templateDoc.name}: ${mediaId}`);
  return mediaId;
}

// Short-lived cache so bulk sends (broadcasts) don't query the template for every recipient.
const headerImageUrlCache = new Map();
const HEADER_IMAGE_CACHE_MS = 60 * 1000;

/**
 * Returns the stable, publicly hosted URL of a template's IMAGE header (or null).
 * This is the single source used to render template images for staff on web AND the Android
 * app: it is stored on each template message as `metadata.templateImageUrl`, a key the mobile
 * app already understands. Meta's own example URLs are signed/expiring and are never used.
 */
async function getTemplateHeaderImageUrl(wabaId, templateName, language) {
  const key = `${wabaId}|${templateName}|${language || ''}`;
  const hit = headerImageUrlCache.get(key);
  if (hit && Date.now() - hit.at < HEADER_IMAGE_CACHE_MS) return hit.url;
  let url = null;
  try {
    const doc = (await Template.findOne({ wabaId, name: templateName, language: language || 'en' }))
      || (await Template.findOne({ wabaId, name: templateName }).sort({ updatedAt: -1 }));
    const header = (doc?.components || []).find(
      (c) => (c.type || '').toUpperCase() === 'HEADER' && (c.format || '').toUpperCase() === 'IMAGE'
    );
    url = header?.hostedImageUrl || null;
  } catch (err) {
    logger.warn(`Could not resolve hosted header image for template ${templateName}: ${err.message}`);
  }
  // Only cache positive results so a freshly hosted image is picked up immediately.
  if (url) headerImageUrlCache.set(key, { url, at: Date.now() });
  return url;
}

/** Points the IMAGE header in a resolved-components array (for chat previews) at the hosted URL. */
function withHostedHeaderImage(components, url) {
  if (!url || !Array.isArray(components)) return components;
  return components.map((c) =>
    (c.type || '').toUpperCase() === 'HEADER' && (c.format || '').toUpperCase() === 'IMAGE'
      ? { ...c, hostedImageUrl: url, imageUrl: url }
      : c
  );
}

async function sendTemplateMessage(wabaId, phoneNumberId, to, templateName, language = 'en', components = [], forceRefreshMedia = false) {
  await checkContactBlockedOrOptedOut(to);
  const path = `/${phoneNumberId}/messages`;

  const buildHeaderMediaParameter = (type, media) => ({
    type,
    [type.toLowerCase()]: media,
  });
  const normalizeTemplateComponentsForMeta = (comps) => {
    if (!Array.isArray(comps)) return comps;
    return comps.map(component => {
      const copy = { ...component };
      if (Object.prototype.hasOwnProperty.call(copy, 'format')) delete copy.format;

      if ((copy.type || '').toLowerCase() === 'header' && !copy.parameters) {
        if (copy.image) {
          copy.parameters = [buildHeaderMediaParameter('image', copy.image)];
          delete copy.image;
        } else if (copy.video) {
          copy.parameters = [buildHeaderMediaParameter('video', copy.video)];
          delete copy.video;
        } else if (copy.document) {
          copy.parameters = [buildHeaderMediaParameter('document', copy.document)];
          delete copy.document;
        }
      }

      return copy;
    });
  };
  
  // Get template from DB to understand component structure
  const Template = require('../models/Template');
  let templateDoc = await Template.findOne({ wabaId, name: templateName, language });
  if (!templateDoc) {
    templateDoc = await Template.findOne({ wabaId, name: templateName }).sort({ updatedAt: -1 });
    if (templateDoc) {
      console.log(`[DEBUG] Template language fallback matched ${templateName}: requested=${language}, stored=${templateDoc.language}`);
    }
  }
  
  let finalComponents = [];
  
  if (templateDoc && templateDoc.components) {
    // Build map of mobile components for easy lookup (handle both singular and plural)
    const mobileCompsByType = {};
    (components || []).forEach(comp => {
      const typeKey = (comp.type || '').toLowerCase();
      mobileCompsByType[typeKey] = comp;
      // Also store with 's' suffix for plural variants (button -> buttons)
      if (typeKey === 'button') {
        mobileCompsByType['buttons'] = comp;
      }
    });
    
    // Process each component type from template
    for (const dbComp of (templateDoc.components || [])) {
      const compType = (dbComp.type || '').toLowerCase();
      const format = (dbComp.format || 'TEXT').toUpperCase();
      const mobileComp = mobileCompsByType[compType];
      
      if (compType === 'header') {
        // For TEXT headers: send with parameters if provided
        if (format === 'TEXT' && mobileComp && mobileComp.parameters) {
          finalComponents.push({
            type: 'header',
            parameters: mobileComp.parameters,
          });
        }
        // For media headers Meta still expects the header component, but example
        // preview URLs from synced templates are not stable delivery assets.
        // Convert the synced preview image into a real uploaded Meta media ID
        // once, cache it on the template, and send the cached ID afterward.
        else if (format === 'IMAGE') {
          const mediaId = await ensureTemplateHeaderImageMediaId(
            wabaId,
            phoneNumberId,
            templateDoc,
            dbComp,
            forceRefreshMedia,
          );

          if (mediaId) {
            finalComponents.push({
              type: 'header',
              parameters: [
                buildHeaderMediaParameter('image', { id: mediaId }),
              ],
            });
          } else {
            console.log(`[DEBUG] Template ${templateName} has IMAGE header without cached media; Meta may reject if no upload is available`);
          }
          // If neither imageMediaId nor imageUrl exist, we cannot provide a valid media header.
        }
      } else if (compType === 'body') {
        // Include body if mobile app sent parameters for it
        if (mobileComp && mobileComp.parameters) {
          finalComponents.push({
            type: 'body',
            parameters: mobileComp.parameters,
          });
        }
      } else if (compType === 'footer') {
        // Include footer if mobile app sent parameters for it
        if (mobileComp && mobileComp.parameters) {
          finalComponents.push({
            type: 'footer',
            parameters: mobileComp.parameters,
          });
        }
      } else if (compType === 'buttons') {
        // Build button components from the TEMPLATE definition (source of truth), not just
        // whatever the client happened to send. A URL button whose url contains {{n}} is
        // dynamic and Meta REQUIRES a parameter for it (else #131008). Every button is
        // handled individually, so templates with several buttons work too.
        const clientButtons = (components || []).filter(c => {
          const t = (c.type || '').toLowerCase();
          return t === 'button' || t === 'buttons';
        });
        const dbButtons = Array.isArray(dbComp.buttons) ? dbComp.buttons : [];

        dbButtons.forEach((btn, btnIdx) => {
          const supplied = clientButtons.find(c => String(c.index) === String(btnIdx));
          const isDynamicUrl =
            (btn?.type || '').toUpperCase() === 'URL' && /\{\{\d+\}\}/.test(btn?.url || '');

          if (isDynamicUrl) {
            const params = (supplied?.parameters || [])
              .filter(p => p && typeof p.text === 'string' && p.text.trim() !== '')
              .map(p => ({ type: 'text', text: p.text.trim() }));
            if (!params.length) {
              const err = new Error(
                `Template "${templateName}" button "${btn.text || btnIdx + 1}" needs a link value (the part that replaces {{1}} in ${btn.url}). Please fill it in and try again.`
              );
              err.statusCode = 400;
              throw err;
            }
            finalComponents.push({
              type: 'button',
              sub_type: 'url',
              index: String(btnIdx),
              parameters: params,
            });
          } else if (supplied && supplied.sub_type && Array.isArray(supplied.parameters) && supplied.parameters.length) {
            // Non-URL buttons that carry parameters (e.g. copy_code, quick_reply payload)
            finalComponents.push({
              type: 'button',
              sub_type: supplied.sub_type,
              index: String(btnIdx),
              parameters: supplied.parameters,
            });
          }
        });
      }
    }
    
    console.log(`[DEBUG] Template ${templateName} has components:`, 
      (templateDoc.components || []).map(c => `${c.type}(${c.format})`).join(', '));
    console.log(`[DEBUG] Mobile app sent:`, 
      (components || []).map(c => `${c.type}`).join(', '));
    console.log(`[DEBUG] Reconstructed for Meta API:`, 
      finalComponents.map(c => `${c.type}(${c.format || 'default'})${c.parameters ? `[${c.parameters.length}p]` : ''}`).join(', '));
  } else {
    // Fallback: normalize any stale client payload before sending to Meta.
    console.log(`[DEBUG] Template not found, normalizing client components as-is`);
    finalComponents = normalizeTemplateComponentsForMeta(components);
  }
  
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/\D/g, ''),
    type: 'template',
    template: { 
      name: templateName, 
      language: { code: language }, 
      components: finalComponents.length ? finalComponents : undefined 
    },
  };
  if (body.template && body.template.components) {
    body.template.components = normalizeTemplateComponentsForMeta(body.template.components);
  }

  console.log(`[DEBUG] Final API request body (sanitized):`, JSON.stringify(body, null, 2));

  try {
    return await request(wabaId, 'POST', path, body);
  } catch (error) {
    // Self-heal: cached header media expired/deleted on Meta's side -> re-upload once and retry.
    if (!forceRefreshMedia && isMetaMediaMissingError(error)) {
      logger.warn(`Template ${templateName}: Meta reported missing/expired header media. Re-uploading and retrying once.`);
      return sendTemplateMessage(wabaId, phoneNumberId, to, templateName, language, components, true);
    }
    throw error;
  }
}

async function sendInteractiveMessage(wabaId, phoneNumberId, to, interactivePayload) {
  await checkContactBlockedOrOptedOut(to);
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
  const extMap = {
    'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
    'audio/aac': 'aac', 'audio/amr': 'amr',
    'image/jpeg': 'jpg', 'image/png': 'png', 'video/mp4': 'mp4',
  };
  const ext = extMap[mimeType] || mimeType.split('/')[1] || 'bin';
  form.append('file', fileBuffer, { filename: `upload.${ext}`, contentType: mimeType, knownLength: fileBuffer.length });
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

// Fields we own locally on a header component. Meta's payload never contains them, so a sync
// must carry them over from the stored template or they would be wiped.
const LOCAL_HEADER_FIELDS = ['hostedImageUrl', 'imageMediaId', 'imageMediaIdUploadedAt', 'imageSource'];

// Comparable representation of what Meta controls in a template (used only for the change summary).
function metaContentSignature(components) {
  return JSON.stringify((components || []).map((c) => ({
    type: (c.type || '').toUpperCase(),
    format: (c.format || 'TEXT').toUpperCase(),
    text: c.text || null,
    buttons: (c.buttons || []).map((b) => ({ type: b.type, text: b.text, url: b.url, phone_number: b.phone_number })),
  })));
}

/**
 * Pulls templates from Meta and upserts them. NON-DESTRUCTIVE:
 *  - locally managed header image fields (hosted copy, cached media ID, source) are preserved
 *  - a template is never deleted because Meta stopped returning it (it is only reported)
 *  - if Meta returns a template with no components, the stored components are kept
 * Records the outcome on the WABA (templateSync) and returns { templates, summary }.
 */
async function syncTemplatesWithSummary(wabaId) {
  const startedAt = Date.now();
  const WabaModel = require('../models/Waba');
  await WabaModel.updateOne({ _id: wabaId }, { $set: { 'templateSync.lastAttemptAt': new Date() } });

  try {
    const waba = await getWaba(wabaId);
    const wabaMetaId = waba.wabaId;

    // Fetch all pages of templates from the Graph API (Graph may paginate results)
    let allTemplates = [];
    const path = `/${wabaMetaId}/message_templates`;
    let cursor = null;
    do {
      const queryPath = cursor ? `${path}?after=${encodeURIComponent(cursor)}` : path;
      const data = await request(wabaId, 'GET', queryPath);
      allTemplates = allTemplates.concat(data.data || []);
      cursor = data.paging && data.paging.cursors && data.paging.cursors.after ? data.paging.cursors.after : null;
    } while (cursor);

    const existingDocs = await Template.find({ wabaId });
    const existingByKey = new Map(existingDocs.map((d) => [`${d.name}|${d.language}`, d]));
    const seenKeys = new Set();
    const summary = { fetched: allTemplates.length, added: [], updated: [], unchanged: 0, notOnMeta: [], localImagesPreserved: 0 };

    for (const t of allTemplates) {
      // Normalize language: ensure we store a string (Graph may return an object)
      let lang = 'en';
      if (t.language) {
        if (typeof t.language === 'string') lang = t.language;
        else if (typeof t.language === 'object' && t.language.code) lang = t.language.code;
        else lang = String(t.language);
      }
      const key = `${t.name}|${lang}`;
      seenKeys.add(key);
      const existing = existingByKey.get(key);
      const existingComps = existing?.components || [];

      let processedComponents;
      if (!(t.components || []).length && existingComps.length) {
        // Meta returned nothing for this template: keep what we have rather than wiping it.
        processedComponents = existingComps.map((c) => (c.toObject ? c.toObject() : { ...c }));
      } else {
        processedComponents = (t.components || []).map((comp) => {
          const processed = { ...comp, format: comp.format || 'TEXT' };
          const isHeader = (comp.type || '').toUpperCase() === 'HEADER';

          // Extract image URL from component example if it's an IMAGE header
          if (isHeader && (comp.format || '').toUpperCase() === 'IMAGE') {
            if (comp.example && Array.isArray(comp.example.header_handle)) {
              processed.imageUrl = comp.example.header_handle[0];
            }
          }
          // Carry over locally managed fields for this component type
          const prior = existingComps.find((c) => (c.type || '').toUpperCase() === (comp.type || '').toUpperCase());
          if (prior && isHeader) {
            let kept = false;
            LOCAL_HEADER_FIELDS.forEach((f) => {
              if (prior[f] !== undefined && prior[f] !== null) { processed[f] = prior[f]; kept = true; }
            });
            // Keep our custom/hosted image reference even if Meta no longer supplies a sample URL
            if (!processed.imageUrl && prior.imageUrl) processed.imageUrl = prior.imageUrl;
            if (kept && prior.hostedImageUrl) summary.localImagesPreserved++;
          }
          return processed;
        });
      }

      if (!existing) {
        summary.added.push(`${t.name} [${lang}]`);
      } else {
        const changes = [];
        if (existing.status !== t.status) changes.push(`status ${existing.status} -> ${t.status}`);
        if (existing.category !== t.category) changes.push(`category ${existing.category} -> ${t.category}`);
        if ((t.components || []).length && metaContentSignature(existingComps) !== metaContentSignature(processedComponents)) changes.push('content changed');
        if (changes.length) summary.updated.push({ name: t.name, language: lang, changes });
        else summary.unchanged++;
      }

      await Template.findOneAndUpdate(
        { wabaId, name: t.name, language: lang },
        {
          wabaId,
          templateId: t.id,
          name: t.name,
          language: lang,
          category: t.category,
          status: t.status,
          components: processedComponents,
          metaData: t,
        },
        { upsert: true, new: true }
      );
    }

    // Templates we have locally that Meta did not return: report only, never delete.
    existingDocs.forEach((d) => {
      if (!seenKeys.has(`${d.name}|${d.language}`)) summary.notOnMeta.push(`${d.name} [${d.language}]`);
    });

    const cap = (arr) => arr.slice(0, 50);
    const stored = {
      fetched: summary.fetched,
      addedCount: summary.added.length,
      updatedCount: summary.updated.length,
      unchanged: summary.unchanged,
      notOnMetaCount: summary.notOnMeta.length,
      localImagesPreserved: summary.localImagesPreserved,
      added: cap(summary.added),
      updated: cap(summary.updated),
      notOnMeta: cap(summary.notOnMeta),
      durationMs: Date.now() - startedAt,
    };
    await WabaModel.updateOne({ _id: wabaId }, {
      $set: { 'templateSync.lastSuccessAt': new Date(), 'templateSync.lastStatus': 'success', 'templateSync.lastError': null, 'templateSync.lastSummary': stored },
    });
    logger.info(`Synced ${allTemplates.length} templates for WABA ${wabaId} (added ${stored.addedCount}, updated ${stored.updatedCount})`);
    return { templates: allTemplates, summary: stored };
  } catch (err) {
    // Failure never touches stored templates; only the status is recorded (last success time is kept).
    await WabaModel.updateOne({ _id: wabaId }, {
      $set: { 'templateSync.lastStatus': 'failed', 'templateSync.lastError': String(err.message || err).slice(0, 300) },
    }).catch(() => {});
    throw err;
  }
}

// Backwards-compatible wrapper (used by the scheduled job): returns the raw Meta list.
async function syncTemplates(wabaId) {
  const { templates } = await syncTemplatesWithSummary(wabaId);
  return templates;
}

async function createTemplate(wabaId, name, category, language, components) {
  const waba = await getWaba(wabaId);
  const wabaMetaId = waba.wabaId;
  const path = `/${wabaMetaId}/message_templates`;
  const body = {
    name,
    category,
    language,
    components
  };
  
  const data = await request(wabaId, 'POST', path, body);
  return data;
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
 * Must be called BEFORE registerPhoneNumber() while the number is UNREGISTERED.
 * Required for Indian numbers and other regions requiring local storage.
 *
 * Per Meta docs (v21+), the POST /{PHONE_NUMBER_ID}/settings endpoint expects:
 * { "storage_configuration": { "status": "IN_COUNTRY_STORAGE_ENABLED", "data_localization_region": "IN" } }
 */
async function setStorageConfiguration(phoneNumberId, region, accessToken) {
  const url = `${BASE_URL}/${phoneNumberId}/settings`;
  console.log(`[EmbeddedSignup] Setting storage config for phone ${phoneNumberId}, region: ${region.toUpperCase()}`);
  const res = await axios.post(url, {
    storage_configuration: {
      status: 'IN_COUNTRY_STORAGE_ENABLED',
      data_localization_region: region.toUpperCase()
    }
  }, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });
  return res.data;
}

/**
 * Register a phone number with WhatsApp Cloud API.
 * For v21+: data_localization_region is DEPRECATED in the register body.
 * Use setStorageConfiguration() FIRST for regions like India.
 */
async function registerPhoneNumber(phoneNumberId, pin, accessToken) {
  const url = `${BASE_URL}/${phoneNumberId}/register`;
  const res = await axios.post(url, {
    messaging_product: 'whatsapp',
    pin: pin
  }, {
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

/**
 * Resolve a messaging limit tier string to its numeric daily limit.
 */
function resolveMessagingLimit(tier) {
  switch (tier) {
    case 'TIER_1K': return 1000;
    case 'TIER_10K': return 10000;
    case 'TIER_100K': return 100000;
    case 'UNLIMITED': return Infinity;
    default: return 100000; // Default to 100k
  }
}

/**
 * Fetch the messaging limit tier for a phone number from Meta Cloud API.
 * GET /{phone-number-id}?fields=messaging_limit_tier
 * Returns { messagingLimitTier: 'TIER_1K', messagingLimit: 1000 }
 */
async function getPhoneNumberMessagingLimit(wabaId, phoneNumberId) {
  const data = await request(wabaId, 'GET', `/${phoneNumberId}?fields=messaging_limit_tier`);
  const tier = data.messaging_limit_tier || null;
  return {
    messagingLimitTier: tier,
    messagingLimit: resolveMessagingLimit(tier),
  };
}

module.exports = {
  syncTemplatesWithSummary,
  hostTemplateHeaderImage,
  getTemplateHeaderImageUrl,
  withHostedHeaderImage,
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
  createTemplate,
  getPhoneNumberMessagingLimit,
  resolveMessagingLimit,
  getAccessToken,
};
