const { parseInboundContent, previewText, parseLocation } = require('../inboundMessage');
const { canApply, allowedPreviousStatuses } = require('../messageStatus');

describe('parseInboundContent', () => {
  test('button reply', () => {
    const p = parseInboundContent({ type: 'button', context: { id: 'wamid.T' }, button: { text: 'Interested', payload: 'INTEREST_1' } });
    expect(p).toMatchObject({ type: 'button', text: 'Interested', botText: 'Interested' });
    expect(p.metadata).toEqual({ kind: 'template_button_reply', button: { text: 'Interested', payload: 'INTEREST_1' }, contextMessageId: 'wamid.T' });
  });

  test('button reply with only a payload still shows something', () => {
    expect(parseInboundContent({ type: 'button', button: { payload: 'YES' } }).text).toBe('YES');
  });

  test('voice note vs audio file', () => {
    expect(parseInboundContent({ type: 'audio', audio: { id: '1', mime_type: 'audio/ogg; codecs=opus', voice: true } }).metadata).toEqual({ voice: true });
    expect(previewText(parseInboundContent({ type: 'audio', audio: { id: '1', voice: true } }))).toBe('🎤 Voice message');
    expect(previewText(parseInboundContent({ type: 'audio', audio: { id: '1' } }))).toBe('🎵 Audio');
  });

  test('location validation', () => {
    expect(parseLocation({ latitude: 22.5, longitude: 88.3 })).toEqual({ latitude: 22.5, longitude: 88.3 });
    expect(parseLocation({ latitude: '22.5', longitude: '88.3' })).toEqual({ latitude: 22.5, longitude: 88.3 });
    expect(parseLocation({ latitude: 95, longitude: 0 })).toBeNull();
    expect(parseLocation({ latitude: 1 })).toBeNull();
    expect(parseLocation({ latitude: 1, longitude: 2, url: 'javascript:alert(1)' })).toEqual({ latitude: 1, longitude: 2 });
  });

  test('flows and other interactive replies', () => {
    expect(parseInboundContent({ type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { body: 'Sent', name: 'flow', response_json: '{}' } } }).text).toBe('📝 Sent');
    expect(parseInboundContent({ type: 'interactive', interactive: { type: 'something_new' } }).metadata.kind).toBe('interactive_other');
  });

  test('every type maps to something the database accepts', () => {
    for (const t of ['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'interactive', 'button', 'contacts', 'order', 'system', 'unsupported', 'request_welcome', 'xyz', '']) {
      const p = parseInboundContent({ type: t, [t]: {} });
      expect(['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'interactive', 'button', 'contacts', 'order', 'system', 'unsupported']).toContain(p.type);
    }
  });

  test('sizes are bounded (no unbounded customer payloads)', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ name: { formatted_name: `N${i}` } }));
    expect(parseInboundContent({ type: 'contacts', contacts: many }).metadata.contacts).toHaveLength(20);
  });
});

describe('status progression', () => {
  test.each([
    [null, 'sent', true], ['sent', 'delivered', true], ['delivered', 'read', true], ['read', 'played', true],
    ['read', 'delivered', false], ['played', 'read', false], ['delivered', 'failed', false], ['sent', 'failed', true],
    ['queued', 'failed', true], ['read', 'read', true], ['sent', 'bogus', false],
  ])('%s -> %s = %s', (cur, next, ok) => expect(canApply(cur, next)).toBe(ok));

  test('played is only reachable forward', () => {
    expect(allowedPreviousStatuses('played')).toEqual(expect.arrayContaining(['sent', 'delivered', 'read']));
  });
});
