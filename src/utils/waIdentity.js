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

/**
 * Country code added to numbers typed or imported WITHOUT one (e.g. a CSV with "9874085669").
 * WhatsApp identifies customers by the full international number (wa_id "919874085669"), so a bare
 * national number would become a second contact / chat for the same customer. Override with
 * DEFAULT_COUNTRY_CODE in .env (digits only) if ever needed.
 */
const DEFAULT_COUNTRY_CODE = String(process.env.DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '') || '91';

/**
 * Full international phone digits for a number typed by staff or imported from a file.
 *   "9874085669", "09874085669", "+91 98740 85669", "0091 9874085669"  ->  "919874085669"
 * For India (the default) only a 10-digit MOBILE number (starts with 6-9), optionally with a
 * leading 0, gets "91" added; anything else (already international, landlines, other lengths) is
 * returned as its digits, unchanged. Returns '' for a BSUID or a value without digits.
 * Only for staff/file input: never use it on webhook wa_ids (those are already international).
 */
function normalizePhone(value, countryCode = DEFAULT_COUNTRY_CODE) {
  let d = phoneDigits(value);
  if (!d) return '';
  const cc = String(countryCode || '').replace(/\D/g, '');
  if (!cc) return d;
  if (d.startsWith('00') && d.length > 11) d = d.slice(2); // international dialling prefix
  if (cc === '91') {
    if (/^0[6-9]\d{9}$/.test(d)) d = d.slice(1);
    return /^[6-9]\d{9}$/.test(d) ? `91${d}` : d;
  }
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length === 10 ? `${cc}${d}` : d;
}

/**
 * Every stored form a number may have: as given (digits), normalised, and — for normalised
 * numbers of the default country — the bare national number. Used to find rows saved before
 * normalisation existed (e.g. broadcast list members stored as "9874085669").
 */
function phoneVariants(value, countryCode = DEFAULT_COUNTRY_CODE) {
  const digits = phoneDigits(value);
  const full = normalizePhone(value, countryCode);
  const out = new Set([digits, full]);
  const cc = String(countryCode || '').replace(/\D/g, '');
  if (cc && full.startsWith(cc) && full.length === cc.length + 10) out.add(full.slice(cc.length));
  out.delete('');
  return [...out];
}

module.exports = {
  BSUID_RE, isBsuid, isParentBsuid, phoneDigits, recipientFields, addressOf, identityFilter, displayIdentity,
  DEFAULT_COUNTRY_CODE, normalizePhone, phoneVariants,
};
