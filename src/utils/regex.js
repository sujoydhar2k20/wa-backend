'use strict';

/** Escape user input so it is matched literally inside a RegExp / $regex. */
function escapeRegex(input) {
    return String(input == null ? '' : input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Phone-aware search term: "+91 72786-65321" -> "917278665321" (digits only) when the
 * input looks like a phone number, otherwise the escaped literal text.
 */
function phoneSearchTerm(input) {
    const s = String(input == null ? '' : input).trim();
    if (/^\+?[\d\s().-]{5,}$/.test(s)) return s.replace(/\D/g, '');
    return escapeRegex(s);
}

module.exports = { escapeRegex, phoneSearchTerm };
