'use strict';

/**
 * Targeted revocation of individual access tokens without rotating the global JWT secret.
 *
 * REVOKED_TOKEN_SHA256 (backend .env) holds a comma-separated list of SHA-256 hex digests of tokens
 * that must no longer authenticate (for example a token that was shipped inside an old APK).
 * Only the digest is stored, never the token itself. Every other session keeps working.
 */
const crypto = require('crypto');

let cached;

function revokedDigests() {
  if (!cached) {
    cached = new Set(
      String(process.env.REVOKED_TOKEN_SHA256 || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[0-9a-f]{64}$/.test(s)),
    );
  }
  return cached;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function isRevoked(token) {
  if (!token) return false;
  const set = revokedDigests();
  if (!set.size) return false;
  return set.has(hashToken(token));
}

/** Tests only: re-read the environment. */
function reset() {
  cached = undefined;
}

module.exports = { isRevoked, hashToken, reset };
