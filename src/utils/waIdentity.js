/**
 * WhatsApp customer identities.
 *
 * A customer can be identified by
 *   - a phone number (wa_id, digits only), and/or
 *   - a business-scoped user ID (BSUID, e.g. "US.13491208655302741918"; parent BSUIDs contain ".ENT.").
 * Since WhatsApp usernames, webhooks may omit the phone number and carry only the BSUID.
 * A BSUID is NEVER a phone number: it must not be stripped to digits or stored in phone fields.
 */

const BSUID_RE = /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]+$/;

function isBsuid(value) {
  return typeof value === 'string' && BSUID_RE.test(value.trim());
}

function isParentBsuid(value) {
  return isBsuid(value) && /\.ENT\./.test(value);
}

/** Phone digits for a wa_id/phone value, or '' when the value is a BSUID or has no digits. */
function phoneDigits(value) {
  if (value === undefined || value === null) return '';
  const s = String(value).trim();
  if (!s || isBsuid(s)) return '';
  return s.replace(/\D/g, '');
}

/**
 * Recipient fields for a Cloud API /messages body.
 * Phone numbers go in `to`; BSUIDs go in `recipient` (Meta: `to` takes precedence when both are present,
 * so we never send both). Throws a 400 error when the value is neither.
 */
function recipientFields(value) {
  const s = value === undefined || value === null ? '' : String(value).trim();
  if (isBsuid(s)) return { recipient: s };
  const digits = phoneDigits(s);
  if (digits) return { to: digits };
  const err = new Error('This customer has no phone number or WhatsApp user ID to send to.');
  err.statusCode = 400;
  err.code = 'NO_RECIPIENT';
  throw err;
}

/** The address to message a chat/contact on: phone when known, else the BSUID. */
function addressOf(doc) {
  if (!doc) return '';
  return phoneDigits(doc.waId) || phoneDigits(doc.phoneNumber) || (isBsuid(doc.bsuid) ? doc.bsuid : '');
}

/** Mongo filter matching a contact/chat by either identity (only the identities that are present). */
function identityFilter({ waId, bsuid } = {}) {
  const or = [];
  const digits = phoneDigits(waId);
  if (digits) or.push({ waId: digits });
  if (isBsuid(bsuid)) or.push({ bsuid });
  return or.length ? { $or: or } : null;
}

/** Short label for UI/logs when there is no name: phone, else "@username", else a shortened BSUID. */
function displayIdentity({ waId, phoneNumber, username, bsuid } = {}) {
  const digits = phoneDigits(waId) || phoneDigits(phoneNumber);
  if (digits) return `+${digits}`;
  if (username) return `@${username}`;
  if (isBsuid(bsuid)) return `WhatsApp user ${bsuid.slice(-6)}`;
  return 'WhatsApp user';
}

module.exports = { BSUID_RE, isBsuid, isParentBsuid, phoneDigits, recipientFields, addressOf, identityFilter, displayIdentity };
