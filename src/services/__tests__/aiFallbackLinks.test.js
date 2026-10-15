'use strict';

jest.mock('../../models', () => ({ AiSetting: {}, AiCategory: {} }));
jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../utils/waIdentity', () => ({ addressOf: jest.fn() }));

const { buildCategoryLinks } = require('../aiFallback.service');

const categories = [{
    name: 'Ring',
    link: 'https://biswakarmagold.com/products?category=Ring',
    subcategories: [{ name: 'Gents Finger Ring', link: 'https://biswakarmagold.com/products?category=Ring&subcategory=Gents+Ring' }],
}];

describe('AI auto-reply links carry the filters', () => {
    test('nested "filters" object (gpt-5-nano style) adds weightMax to the link', () => {
        const ai = { language: null, 'Main Category': 'Ring', 'Sub Category': 'Gents Finger Ring',
            filters: { purity: null, size: null, priceMax: null, weightMax: 5 } };
        const [link] = buildCategoryLinks(ai, categories, {});
        expect(link.url).toBe('https://biswakarmagold.com/products?category=Ring&subcategory=Gents+Ring&weightMax=5&sortBy=price_desc');
    });

    test('flat filters (older style) still work', () => {
        const ai = { 'Main Category': 'Ring', 'Sub Category': 'Gents Finger Ring', purity: '22K', weightMax: 5 };
        const [link] = buildCategoryLinks(ai, categories, {});
        expect(link.url).toContain('purity=22K');
        expect(link.url).toContain('weightMax=5');
    });

    test('nested filters in a results array, and unknown keys ignored', () => {
        const ai = { results: [{ 'Main Category': 'Ring', filters: { priceMax: 50000, colour: 'red' } }] };
        const [link] = buildCategoryLinks(ai, categories, {});
        expect(link.url).toBe('https://biswakarmagold.com/products?category=Ring&priceMax=50000&sortBy=price_desc');
    });

    test('no filters gives the plain link', () => {
        const [link] = buildCategoryLinks({ 'Main Category': 'Ring', filters: { weightMax: null } }, categories, {});
        expect(link.url).toBe('https://biswakarmagold.com/products?category=Ring&sortBy=price_desc');
    });
});
