/**
 * Text normalization utilities for multi-language support.
 * Handles Bengali, Hindi, English and other scripts.
 */

const { logger } = require('./logger');

/**
 * Normalize text for multi-language keyword/option matching.
 * Handles Latin and Indic scripts (Bengali, Hindi, etc.) by:
 * 1. Trimming whitespace
 * 2. Normalizing to NFC form (for combining characters)
 * 3. Converting to lowercase for Latin characters
 * 4. Handling common punctuation and special characters
 */
function normalizeText(text) {
    if (!text) return '';
    
    try {
        // Trim whitespace and normalize Unicode
        let normalized = text.trim();
        
        // Normalize to NFC (composed form) for consistent matching
        if (typeof normalized.normalize === 'function') {
            normalized = normalized.normalize('NFC');
        }
        
        // Convert to lowercase - this works for Latin scripts and is harmless for Indic scripts
        normalized = normalized.toLowerCase();
        
        // Remove common punctuation marks but preserve word characters
        // This helps match "What is your website link?" with "website link"
        normalized = normalized.replace(/[.,!?;:''""()\-–—…]/g, ' ');
        
        // Collapse multiple spaces to single space
        normalized = normalized.replace(/\s+/g, ' ').trim();
        
        return normalized;
    } catch (err) {
        logger.warn(`Error normalizing text: ${err.message}, proceeding with basic trim`);
        return text.trim().toLowerCase();
    }
}

/**
 * Check if two texts are equal after normalization.
 * Useful for button/option matching and condition equality checks.
 */
function normalizedEquals(text1, text2) {
    return normalizeText(text1) === normalizeText(text2);
}

/**
 * Check if one normalized text contains another.
 * Useful for partial keyword/text matching.
 */
function normalizedIncludes(text1, text2) {
    return normalizeText(text1).includes(normalizeText(text2));
}

module.exports = {
    normalizeText,
    normalizedEquals,
    normalizedIncludes,
};
