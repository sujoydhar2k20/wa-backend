/**
 * Integration tests for the bot-builder fixes (Oct 2026), with a real in-memory MongoDB and a
 * mocked WhatsApp API:
 *   1. buttons keep their branch after another button is deleted (permanent ids)
 *   2. a failed buttons message stops the flow instead of running every branch
 *   3. "first message of the day" fires (uses the previous message time, IST day)
 *   4. a flow cannot start twice (two messages together / open conversation + new lead)
 *   5. flows only run on their own WhatsApp account
 */
jest.setTimeout(60000);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const db = require('../../testutils/memoryDb');
const mockIo = db.fakeIO();
jest.mock('../../websocket/socket.server', () => ({ getIO: () => mockIo }));

const mockSent = [];
let mockFailInteractive = false;
jest.mock('../whatsapp.service', () => ({
  sendTextMessage: jest.fn(async (_w, _p, _to, text) => {
    mockSent.push({ kind: 'text', text });
    return { messages: [{ id: `wamid.T${mockSent.length}` }] };
  }),
  sendInteractiveMessage: jest.fn(async (_w, _p, _to, payload) => {
    if (mockFailInteractive) throw new Error('(#131009) Parameter value is not valid');
    mockSent.push({ kind: 'interactive', payload });
    return { messages: [{ id: `wamid.T${mockSent.length}` }] };
  }),
}));

const mongoose = require('mongoose');
const { Waba, Chat, BotFlow, BotExecution } = require('../../models');
const bot = require('../bot.service');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const texts = () => mockSent.filter((m) => m.kind === 'text').map((m) => m.text);

async function settle(ms = 400) {
  // flows run in the background after the lock is released
  await sleep(ms);
}

let wabaA, wabaB, n = 0;
async function newChat(waba = wabaA) {
  n += 1;
  return (await Chat.create({
    wabaId: waba._id, phoneNumberId: 'pn-a', phoneNumber: `9198000000${n}`, waId: `9198000000${n}`, status: 'open',
  })).toObject();
}
const trig = { id: 'trigger_0', type: 'trigger', config: {}, position: { x: 0, y: 0 } };
const msgNode = (id, text) => ({ id, type: 'send_message', config: { text }, position: { x: 0, y: 0 } });
const edge = (source, target, sourceHandle) => ({ id: `${source}-${target}-${sourceHandle || ''}`, source, target, sourceHandle });

beforeAll(async () => { await db.start(); });
afterAll(async () => { await db.stop(); });
beforeEach(async () => {
  await db.clear();
  mockSent.length = 0;
  mockFailInteractive = false;
  wabaA = await Waba.create({ wabaId: 'A1', businessName: 'Shop A', accessToken: 't', phoneNumbers: [{ phoneNumberId: 'pn-a', phoneNumber: '911' }] });
  wabaB = await Waba.create({ wabaId: 'B1', businessName: 'Shop B', accessToken: 't', phoneNumbers: [{ phoneNumberId: 'pn-b', phoneNumber: '922' }] });
});

function buttonsFlow(config, edges, extra = {}) {
  return BotFlow.create({
    name: 'Menu', isEnabled: true, trigger: { type: 'on_message', keywords: ['menu'], matchType: 'exact' },
    nodes: [trig, { id: 'b', type: 'send_interactive', config: { bodyText: 'Pick one', ...config }, position: { x: 0, y: 0 } },
      msgNode('price', 'PRICE'), msgNode('loc', 'LOCATION'), msgNode('staff', 'STAFF')],
    edges: [edge('trigger_0', 'b'), ...edges],
    ...extra,
  });
}

describe('1. permanent button ids', () => {
  test('after deleting the middle button, "Talk to staff" still goes to the staff branch', async () => {
    // Old flow (position ids btn_0/1/2) after the editor deleted "Location": ids stay with their buttons.
    await buttonsFlow(
      { buttons: ['Price', 'Talk to staff'], buttonIds: ['btn_0', 'btn_2'] },
      [edge('b', 'price', 'btn_0'), edge('b', 'staff', 'btn_2')],
    );
    const chat = await newChat();
    await bot.processIncomingMessage({ waba: wabaA, phoneNumberId: 'pn-a', chat, message: {}, text: 'menu' });
    await settle();
    const sentButtons = mockSent.find((m) => m.kind === 'interactive').payload.action.buttons;
    expect(sentButtons.map((b) => b.reply)).toEqual([{ id: 'btn_0', title: 'Price' }, { id: 'btn_2', title: 'Talk to staff' }]);

    await bot.processIncomingMessage({
      waba: wabaA, phoneNumberId: 'pn-a', chat, text: 'Talk to staff',
      message: { metadata: { button_reply: { id: 'btn_2', title: 'Talk to staff' } } },
    });
    await settle();
    expect(texts()).toEqual(['STAFF']);
  });

  test('old flows without ids keep working, and typed button titles are matched', async () => {
    await buttonsFlow({ buttons: ['Price', 'Location', 'Talk to staff'] },
      [edge('b', 'price', 'btn_0'), edge('b', 'loc', 'btn_1'), edge('b', 'staff', 'btn_2')]);
    const chat = await newChat();
    await bot.processIncomingMessage({ waba: wabaA, phoneNumberId: 'pn-a', chat, message: {}, text: 'menu' });
    await settle();
    await bot.processIncomingMessage({ waba: wabaA, phoneNumberId: 'pn-a', chat, message: {}, text: 'location' });
    await settle();
    expect(texts()).toEqual(['LOCATION']);
  });

  test('a double tap resumes the flow only once', async () => {
    await buttonsFlow({ buttons: ['Price'], buttonIds: ['btn_0'] }, [edge('b', 'price', 'btn_0')]);
    const chat = await newChat();
    await bot.processIncomingMessage({ waba: wabaA, phoneNumberId: 'pn-a', chat, message: {}, text: 'menu' });
    await settle();
    const tap = { waba: wabaA, phoneNumberId: 'pn-a', chat, text: 'Price', message: { metadata: { button_reply: { id: 'btn_0' } } } };
    await Promise.all([bot.processIncomingMessage(tap), bot.processIncomingMessage(tap)]);
    await settle();
    expect(texts()).toEqual(['PRICE']);
  });
});

describe('2. failed buttons message', () => {
  test('stops the flow: no branch runs and the execution is marked failed', async () => {
    mockFailInteractive = true;
    await buttonsFlow({ buttons: ['Price', 'Location', 'Talk to staff'] },
      [edge('b', 'price', 'btn_0'), edge('b', 'loc', 'btn_1'), edge('b', 'staff', 'btn_2')]);
    const chat = await newChat();
    await bot.processIncomingMessage({ waba: wabaA, phoneNumberId: 'pn-a', chat, message: {}, text: 'menu' });
    await settle();
    expect(texts()).toEqual([]);
    const ex = await BotExecution.findOne({ chatId: chat._id }).lean();
    expect(ex.status).toBe('failed');
  });
});

describe('3. first message of the day', () => {
  async function dailyFlow() {
    await BotFlow.create({
      name: 'Daily', isEnabled: true, trigger: { type: 'on_first_daily_message' },
      nodes: [trig, msgNode('m', 'GOOD MORNING')], edges: [edge('trigger_0', 'm')],
    });
  }
  test('fires when the previous message was on an earlier day (even though the chat was just stamped "now")', async () => {
    await dailyFlow();
    const chat = { ...(await newChat()), lastCustomerMessageAt: new Date() };
    const yesterday = new Date(Date.now() - 26 * 3600 * 1000);
    await bot.processIncomingMessage({ waba: wabaA, phoneNumberId: 'pn-a', chat, message: {}, text: 'hi', previousCustomerMessageAt: yesterday });
    await settle();
    expect(texts()).toEqual(['GOOD MORNING']);
  });
  test('does not fire again the same day', async () => {
    await dailyFlow();
    const chat = { ...(await newChat()), lastCustomerMessageAt: new Date() };
    await bot.processIncomingMessage({ waba: wabaA, phoneNumberId: 'pn-a', chat, message: {}, text: 'hi', previousCustomerMessageAt: new Date(Date.now() - 60 * 1000) });
    await settle();
    expect(texts()).toEqual([]);
  });
  test('compares calendar days in India time, not server time', () => {
    // 23:50 IST on 14 Oct and 00:10 IST on 15 Oct are different days in India (same UTC day).
    const prev = new Date('2026-10-14T18:20:00Z');
    jest.useFakeTimers({ now: new Date('2026-10-14T18:40:00Z'), doNotFake: ['setTimeout', 'setImmediate', 'nextTick'] });
    try {
      expect(bot.evaluateTrigger({ type: 'on_first_daily_message' }, { chat: {}, previousCustomerMessageAt: prev }).matched).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('4. no duplicate starts', () => {
  test('two messages arriving together start the welcome flow once', async () => {
    await BotFlow.create({
      name: 'Welcome', isEnabled: true, trigger: { type: 'on_message', keywords: [] },
      nodes: [trig, msgNode('m', 'WELCOME'), { id: 'd', type: 'time_delay', config: { duration: 1, unit: 'seconds' } }, msgNode('m2', 'HOW CAN WE HELP')],
      edges: [edge('trigger_0', 'm'), edge('m', 'd'), edge('d', 'm2')],
    });
    const chat = await newChat();
    const m = { waba: wabaA, phoneNumberId: 'pn-a', chat, message: {}, isNewChat: true, previousCustomerMessageAt: null };
    await Promise.all([bot.processIncomingMessage({ ...m, text: 'hi' }), bot.processIncomingMessage({ ...m, text: 'hello' })]);
    await settle(1600);
    expect(texts()).toEqual(['WELCOME', 'HOW CAN WE HELP']);
    expect(await BotExecution.countDocuments({ chatId: chat._id })).toBe(1);
  });

  test('new chat with both an "open conversation" and a "new lead" flow: only one runs', async () => {
    await BotFlow.create({ name: 'Open', isEnabled: true, trigger: { type: 'on_open_conversation' }, nodes: [trig, msgNode('m', 'OPEN')], edges: [edge('trigger_0', 'm')] });
    await BotFlow.create({ name: 'Lead', isEnabled: true, trigger: { type: 'on_new_lead' }, nodes: [trig, msgNode('m', 'LEAD')], edges: [edge('trigger_0', 'm')] });
    const chat = await newChat();
    await bot.processIncomingMessage({ waba: wabaA, phoneNumberId: 'pn-a', chat, message: {}, text: 'hi', isNewChat: true, previousCustomerMessageAt: null });
    await settle();
    expect(texts()).toEqual(['OPEN']);
  });

  test('a flow paused on a long delay is not started again by the next message', async () => {
    const agenda = require('../../jobs/agenda');
    jest.spyOn(agenda, 'getAgenda').mockReturnValue({ schedule: jest.fn(async () => ({})) });
    await BotFlow.create({
      name: 'Follow-up', isEnabled: true, trigger: { type: 'on_message', keywords: [] },
      nodes: [trig, msgNode('m', 'THANKS'), { id: 'd', type: 'time_delay', config: { duration: 2, unit: 'hours' } }, msgNode('m2', 'STILL INTERESTED?')],
      edges: [edge('trigger_0', 'm'), edge('m', 'd'), edge('d', 'm2')],
    });
    const chat = await newChat();
    const m = { waba: wabaA, phoneNumberId: 'pn-a', chat, message: {} };
    await bot.processIncomingMessage({ ...m, text: 'hi' });
    await settle();
    await bot.processIncomingMessage({ ...m, text: 'one more thing' });
    await settle();
    expect(texts()).toEqual(['THANKS']);
    expect((await BotExecution.find({ chatId: chat._id }).lean()).map((e) => e.status)).toEqual(['waiting']);
  });
});

describe('5. flows per WhatsApp account', () => {
  test('a flow for account B does not reply on account A; "all numbers" flows still do', async () => {
    await BotFlow.create({ name: 'B only', isEnabled: true, wabaId: wabaB._id, trigger: { type: 'on_message', keywords: ['price'] }, nodes: [trig, msgNode('m', 'B PRICE')], edges: [edge('trigger_0', 'm')] });
    await BotFlow.create({ name: 'All', isEnabled: true, trigger: { type: 'on_message', keywords: ['price'] }, nodes: [trig, msgNode('m', 'ALL PRICE')], edges: [edge('trigger_0', 'm')] });
    const chatA = await newChat(wabaA);
    await bot.processIncomingMessage({ waba: wabaA, phoneNumberId: 'pn-a', chat: chatA, message: {}, text: 'price' });
    await settle();
    expect(texts()).toEqual(['ALL PRICE']);

    mockSent.length = 0;
    await BotFlow.deleteOne({ name: 'All' });
    const chatB = await newChat(wabaB);
    await bot.processIncomingMessage({ waba: wabaB, phoneNumberId: 'pn-b', chat: chatB, message: {}, text: 'price' });
    await settle();
    expect(texts()).toEqual(['B PRICE']);
  });
});
