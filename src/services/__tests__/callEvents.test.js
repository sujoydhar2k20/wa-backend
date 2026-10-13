const { isCallGeneratedMessage } = require('../calls/callEvents');

describe('incoming calls never trigger the bot', () => {
  test('automatic call permission sent when a customer calls', () => {
    const msg = { type: 'interactive', interactive: { type: 'call_permission_reply', call_permission_reply: { response: 'accept', response_source: 'automatic' } } };
    expect(isCallGeneratedMessage({ msg, messageData: { metadata: { kind: 'call_permission_reply' } } })).toBe(true);
    expect(isCallGeneratedMessage({ msg, messageData: {} })).toBe(true);
  });

  test('call-type messages', () => {
    expect(isCallGeneratedMessage({ msg: { type: 'call' }, messageData: {} })).toBe(true);
  });

  test('placeholders only count while/just after a call', () => {
    expect(isCallGeneratedMessage({ msg: { type: 'unsupported' }, messageData: {}, recentInboundCall: true })).toBe(true);
    expect(isCallGeneratedMessage({ msg: { type: 'unsupported' }, messageData: {}, recentInboundCall: false })).toBe(false);
  });

  test('real customer messages still reach the bot, even during a call', () => {
    expect(isCallGeneratedMessage({ msg: { type: 'text', text: { body: 'hi' } }, messageData: { text: 'hi' }, recentInboundCall: true })).toBe(false);
    expect(isCallGeneratedMessage({ msg: { type: 'interactive', interactive: { type: 'button_reply' } }, messageData: {} })).toBe(false);
    expect(isCallGeneratedMessage({ msg: { type: 'image' }, messageData: {}, recentInboundCall: true })).toBe(false);
  });
});
