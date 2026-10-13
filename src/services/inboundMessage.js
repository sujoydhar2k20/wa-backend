'use strict';

/**
 * Pure parsing of one inbound WhatsApp Cloud API message (webhook `value.messages[i]`) into what we
 * store. No database or network access here, so every message type is unit-tested.
 *
 * Every message gets a readable `text`, so any client (including older app builds that only know a
 * few types) can at least show something, and nothing is ever dropped: types we do not model are kept
 * as `unsupported` with the original type in metadata.
 *
 * Payload shapes: WhatsApp Cloud API webhook reference (messages: text, button, contacts, order,
 * location, sticker, unsupported, system, interactive, reaction), checked October 2026 (Graph v25.0).
 */

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'];

/** Types the Message model stores as-is. Anything else becomes `unsupported`. */
const STORED_TYPES = new Set([
  'text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'reaction', 'interactive',
  'button', 'contacts', 'order', 'system', 'unsupported',
]);

const str = (v, max = 1000) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/** Valid WGS84 coordinates, or null. */
function parseLocation(loc) {
  if (!loc || typeof loc !== 'object') return null;
  const latitude = num(loc.latitude);
  const longitude = num(loc.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  const out = { latitude, longitude };
  if (loc.name) out.name = str(loc.name, 200);
  if (loc.address) out.address = str(loc.address, 500);
  if (typeof loc.url === 'string' && /^https?:\/\//i.test(loc.url)) out.url = str(loc.url, 500);
  return out;
}

/** Shared contact cards: only the fields WhatsApp documents, bounded in size. */
function parseContactCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards.slice(0, 20).map((c) => {
    const name = c?.name || {};
    const card = {
      name: {
        formatted_name: str(name.formatted_name, 200),
        first_name: str(name.first_name, 100),
        last_name: str(name.last_name, 100),
      },
      phones: (Array.isArray(c?.phones) ? c.phones : []).slice(0, 10).map((p) => ({
        phone: str(p?.phone, 40), wa_id: str(p?.wa_id, 40), type: str(p?.type, 20),
      })),
      emails: (Array.isArray(c?.emails) ? c.emails : []).slice(0, 10).map((e) => ({ email: str(e?.email, 200), type: str(e?.type, 20) })),
    };
    if (c?.org) card.org = { company: str(c.org.company, 200), department: str(c.org.department, 200), title: str(c.org.title, 200) };
    if (Array.isArray(c?.urls)) card.urls = c.urls.slice(0, 5).map((u) => ({ url: str(u?.url, 300), type: str(u?.type, 20) }));
    if (Array.isArray(c?.addresses)) {
      card.addresses = c.addresses.slice(0, 5).map((a) => ({
        street: str(a?.street, 200), city: str(a?.city, 100), state: str(a?.state, 100),
        zip: str(a?.zip, 20), country: str(a?.country, 100), country_code: str(a?.country_code, 5), type: str(a?.type, 20),
      }));
    }
    if (c?.birthday) card.birthday = str(c.birthday, 20);
    if (c?.origin) card.origin = str(c.origin, 40); // "contact_request" when shared via a request-contact button
    return card;
  });
}

function contactCardLabel(card) {
  const name = card.name.formatted_name || [card.name.first_name, card.name.last_name].filter(Boolean).join(' ');
  const phone = card.phones.find((p) => p.phone || p.wa_id);
  return [name || 'Contact', phone ? (phone.phone || `+${phone.wa_id}`) : ''].filter(Boolean).join(' · ');
}

function parseOrder(order) {
  if (!order || typeof order !== 'object') return null;
  const items = (Array.isArray(order.product_items) ? order.product_items : []).slice(0, 100).map((i) => ({
    product_retailer_id: str(i?.product_retailer_id, 100),
    quantity: Number.isFinite(num(i?.quantity)) ? num(i.quantity) : 0,
    item_price: Number.isFinite(num(i?.item_price)) ? num(i.item_price) : null,
    currency: str(i?.currency, 5),
  }));
  return { catalog_id: str(order.catalog_id, 100), text: str(order.text, 1000), product_items: items };
}

function orderLabel(order) {
  const count = order.product_items.reduce((n, i) => n + (i.quantity || 0), 0);
  const priced = order.product_items.filter((i) => i.item_price != null);
  const currency = priced[0]?.currency || '';
  const sameCurrency = priced.every((i) => i.currency === currency);
  const total = priced.reduce((s, i) => s + i.item_price * (i.quantity || 0), 0);
  const totalText = priced.length && sameCurrency ? ` · ${currency} ${Math.round(total * 100) / 100}` : '';
  return `🛒 Order: ${count} item${count === 1 ? '' : 's'}${totalText}${order.text ? ` — ${order.text}` : ''}`;
}

const UNSUPPORTED_LABELS = {
  poll_creation: 'a poll', poll_update: 'a poll vote', gif: 'a GIF', group_invite: 'a group invite',
  edit: 'an edited message', pin: 'a pinned message', keep_in_chat: 'a "keep in chat" action',
  media_placeholder: 'media that is not available yet', product: 'a product', list: 'a list',
  link_preview: 'a link preview',
};

function errorsOf(msg) {
  return (Array.isArray(msg?.errors) ? msg.errors : []).slice(0, 5).map((e) => ({
    code: e?.code, title: str(e?.title || e?.message, 200), details: str(e?.error_data?.details, 300),
  }));
}

/**
 * @returns {{
 *   type: string, text: string, metadata: object|undefined, location: object|undefined,
 *   media: {field: string, id: string, mimeType: string, caption: string|null, fileName: string|undefined, animated?: boolean}|null,
 *   botText: string, isSystemEvent: boolean, contextMessageId: string|undefined
 * }}
 */
function parseInboundContent(msg) {
  const type = String(msg?.type || '');
  const out = {
    type, text: '', metadata: undefined, location: undefined, media: null,
    botText: '', isSystemEvent: false, contextMessageId: msg?.context?.id || undefined,
  };

  switch (type) {
    case 'text':
      out.text = str(msg.text?.body, 4096);
      out.botText = out.text;
      break;

    case 'button': {
      // Customer tapped a quick-reply button of a template we sent.
      const label = str(msg.button?.text || msg.button?.payload, 256);
      out.text = label || 'Button reply';
      out.metadata = {
        kind: 'template_button_reply',
        button: { text: str(msg.button?.text, 256), payload: str(msg.button?.payload, 1024) },
        ...(msg.context?.id ? { contextMessageId: msg.context.id } : {}),
      };
      out.botText = label;
      break;
    }

    case 'contacts': {
      const cards = parseContactCards(msg.contacts);
      out.text = cards.length
        ? `👤 ${cards.length === 1 ? 'Shared contact' : `${cards.length} shared contacts`}: ${cards.map(contactCardLabel).join(', ')}`
        : '👤 Shared contact';
      out.metadata = { kind: 'contacts', contacts: cards };
      break;
    }

    case 'order': {
      const order = parseOrder(msg.order);
      out.text = order ? orderLabel(order) : '🛒 Order';
      out.metadata = { kind: 'order', order: order || {} };
      break;
    }

    case 'location': {
      const loc = parseLocation(msg.location);
      if (loc) {
        out.location = loc;
        out.text = `📍 ${[loc.name, loc.address].filter(Boolean).join(', ') || 'Location'}`;
      } else {
        // Incomplete or invalid coordinates: keep the message, say so.
        out.text = '📍 Location (coordinates missing)';
        out.metadata = { kind: 'location_invalid' };
      }
      break;
    }

    case 'image': case 'video': case 'audio': case 'document': case 'sticker': {
      const m = msg[type] || {};
      out.media = {
        field: type,
        id: str(m.id, 200),
        mimeType: str(m.mime_type, 100),
        caption: m.caption ? str(m.caption, 4096) : null,
        fileName: type === 'document' && m.filename ? str(m.filename, 255) : undefined,
        ...(type === 'sticker' ? { animated: m.animated === true } : {}),
        ...(type === 'audio' && m.voice === true ? { voice: true } : {}),
      };
      if (type === 'sticker') out.metadata = { kind: 'sticker', animated: m.animated === true };
      if (type === 'audio' && m.voice === true) out.metadata = { voice: true };
      break;
    }

    case 'interactive': {
      const it = msg.interactive || {};
      if (it.type === 'button_reply' && it.button_reply) {
        out.text = str(it.button_reply.title, 256);
        out.metadata = { button_reply: { id: str(it.button_reply.id, 256), title: str(it.button_reply.title, 256) } };
      } else if (it.type === 'list_reply' && it.list_reply) {
        out.text = str(it.list_reply.title, 256);
        out.metadata = { list_reply: { id: str(it.list_reply.id, 256), title: str(it.list_reply.title, 256), description: str(it.list_reply.description, 512) } };
      } else if (it.type === 'nfm_reply' && it.nfm_reply) {
        out.text = `📝 ${str(it.nfm_reply.body || it.nfm_reply.name || 'Form submitted', 256)}`;
        out.metadata = { kind: 'nfm_reply', nfm_reply: { name: str(it.nfm_reply.name, 100), response_json: str(it.nfm_reply.response_json, 8000) } };
      } else if (it.type === 'call_permission_reply' && it.call_permission_reply) {
        // Text and side effects are produced by the webhook service (permissions recording).
        out.metadata = { kind: 'call_permission_reply', call_permission_reply: it.call_permission_reply };
      } else {
        out.text = `Interactive reply${it.type ? ` (${str(it.type, 40)})` : ''}`;
        out.metadata = { kind: 'interactive_other', interactiveType: str(it.type, 40) };
      }
      out.botText = out.text;
      break;
    }

    case 'system': {
      const sys = msg.system || {};
      out.isSystemEvent = true;
      out.text = str(sys.body, 500) || `System update (${str(sys.type, 40) || 'unknown'})`;
      out.metadata = {
        kind: 'whatsapp_system',
        systemType: str(sys.type, 60),
        ...(sys.wa_id ? { wa_id: str(sys.wa_id, 40) } : {}),
        ...(sys.user_id ? { user_id: str(sys.user_id, 80) } : {}),
        ...(sys.parent_user_id ? { parent_user_id: str(sys.parent_user_id, 80) } : {}),
      };
      break;
    }

    case 'reaction':
      // Handled separately (attached to the reacted message); never stored as its own message.
      break;

    case 'unsupported':
    default: {
      const original = type === 'unsupported' ? str(msg.unsupported?.type, 60) : type || 'unknown';
      const label = UNSUPPORTED_LABELS[original] || (original ? `a "${original}" message` : 'a message');
      out.type = 'unsupported';
      out.text = `⚠️ The customer sent ${label} that cannot be shown here. Please check WhatsApp on the phone if needed.`;
      out.metadata = { kind: 'unsupported', originalType: original || 'unknown', errors: errorsOf(msg) };
      break;
    }
  }

  if (!STORED_TYPES.has(out.type)) {
    // Defensive: never hand the database a type it would reject.
    out.metadata = { kind: 'unsupported', originalType: out.type, errors: errorsOf(msg) };
    out.type = 'unsupported';
    out.text = out.text || '⚠️ The customer sent a message that cannot be shown here.';
  }
  return out;
}

/** One-line preview used for notifications and chat snippets. */
function previewText(parsed) {
  if (parsed.media) {
    const cap = parsed.media.caption;
    switch (parsed.media.field) {
      case 'image': return cap ? `📷 Image: ${cap}` : '📷 Image';
      case 'video': return cap ? `🎥 Video: ${cap}` : '🎥 Video';
      case 'audio': return parsed.media.voice ? '🎤 Voice message' : '🎵 Audio';
      case 'document': return parsed.media.fileName ? `📄 ${parsed.media.fileName}` : '📄 Document';
      case 'sticker': return '🖼️ Sticker';
      default: return 'Media';
    }
  }
  return parsed.text || 'New message';
}

module.exports = { parseInboundContent, previewText, parseLocation, parseContactCards, parseOrder, MEDIA_TYPES, STORED_TYPES };
