/**
 * Permanent IDs for interactive buttons / list items in bot flows.
 *
 * Each button (config.buttons[i]) and list item (config.listItems[i]) has a matching
 * permanent id in config.buttonIds[i] / config.listItemIds[i]. Flow arrows attach to
 * that id, so deleting one button never shifts the others onto the wrong branch.
 *
 * Flows saved before permanent ids existed have no id arrays: their ids are the old
 * position-based ones ("btn_0", "item_2"), which is exactly what their arrows use.
 */

const { normalizeText } = require('./textNormalization');

const KINDS = {
    button: { values: 'buttons', ids: 'buttonIds', prefix: 'btn' },
    list: { values: 'listItems', ids: 'listItemIds', prefix: 'item' },
};

/** Returns the id for every option of the node, aligned with its values array. */
function optionIds(config = {}, kind = 'button') {
    const k = KINDS[kind];
    const values = Array.isArray(config[k.values]) ? config[k.values] : [];
    const ids = Array.isArray(config[k.ids]) ? config[k.ids] : null;
    return values.map((_, i) => (ids && ids[i]) ? String(ids[i]) : `${k.prefix}_${i}`);
}

/**
 * Id of the option whose title matches the customer's typed text (case-insensitive),
 * with multi-language support for Bengali, Hindi, etc.
 * Returns null if no match found.
 */
function optionIdForText(config = {}, kind = 'button', text = '') {
    const k = KINDS[kind];
    const values = Array.isArray(config[k.values]) ? config[k.values] : [];
    const wanted = normalizeText(text || '');
    if (!wanted) return null;
    
    const idx = values.findIndex(v => normalizeText(String(v || '')) === wanted);
    return idx === -1 ? null : optionIds(config, kind)[idx];
}

module.exports = { optionIds, optionIdForText };

