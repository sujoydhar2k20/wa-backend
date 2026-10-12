const { buildReport, parseRange, toCsv } = require('../reports');

const A = 'a'.repeat(24); // assigned staff
const B = 'b'.repeat(24);
const t = (iso) => new Date(iso);
const users = { [A]: 'Rina', [B]: 'Mou' };

const calls = [
  // answered by Rina after 10 s, talked 60 s (IST 10:00 on 12 Oct)
  { _id: '1', direction: 'inbound', status: 'terminated', waId: '911', startedAt: t('2026-10-12T04:30:00Z'), createdAt: t('2026-10-12T04:30:00Z'), answeredAt: t('2026-10-12T04:30:10Z'), answeredBy: A, duration: 60, metadata: { plan: { first: [A] } } },
  // answered by Mou in stage 2 after 30 s, Rina declined
  { _id: '2', direction: 'inbound', status: 'terminated', waId: '912', startedAt: t('2026-10-12T05:00:00Z'), createdAt: t('2026-10-12T05:00:00Z'), answeredAt: t('2026-10-12T05:00:30Z'), answeredBy: B, duration: 20, metadata: { plan: { first: [A] }, declinedBy: [A] } },
  // missed, assigned to Rina, followed up
  { _id: '3', direction: 'inbound', status: 'missed', waId: '913', chatId: 'c3', createdAt: t('2026-10-13T12:00:00Z'), metadata: { plan: { first: [A] }, contactName: 'Asha' } },
  // missed, nobody assigned, not followed up
  { _id: '4', direction: 'inbound', status: 'missed', waId: '914', chatId: 'c4', createdAt: t('2026-10-13T13:00:00Z'), metadata: { contactName: 'Bina' } },
  // outbound by Rina connected 40 s; one not answered; one blocked
  { _id: '5', direction: 'outbound', status: 'terminated', waId: '913', initiatedBy: A, createdAt: t('2026-10-13T12:10:00Z'), answeredAt: t('2026-10-13T12:10:08Z'), duration: 40 },
  { _id: '6', direction: 'outbound', status: 'terminated', waId: '915', initiatedBy: A, createdAt: t('2026-10-13T12:20:00Z'), duration: 0 },
  { _id: '7', direction: 'outbound', status: 'blocked', waId: '916', initiatedBy: B, createdAt: t('2026-10-13T12:30:00Z'), duration: 0 },
  // still ringing: ignored
  { _id: '8', direction: 'inbound', status: 'ringing', waId: '917', createdAt: t('2026-10-13T12:40:00Z') },
];

describe('call reports', () => {
  const r = buildReport({ calls, users, followUps: { 3: { at: t('2026-10-13T12:10:00Z'), how: 'called back' } }, from: t('2026-10-11T18:30:00Z'), to: t('2026-10-13T18:29:59Z') });

  test('totals', () => {
    expect(r.totals).toMatchObject({
      inbound: 4, inboundAnswered: 2, inboundMissed: 2, answerRate: 50, avgSecondsToAnswer: 20, answeredWithin25s: 50,
      outbound: 3, outboundConnected: 1, outboundNotAnswered: 1, outboundBlocked: 1,
      talkSeconds: 120, avgTalkSeconds: 40, missedFollowedUp: 1, missedNotFollowedUp: 1,
    });
  });

  test('per staff', () => {
    const rina = r.perStaff.find((x) => x.name === 'Rina');
    const mou = r.perStaff.find((x) => x.name === 'Mou');
    expect(rina).toMatchObject({ answered: 1, missedWhileAssigned: 1, declined: 1, outbound: 2, outboundConnected: 1, talkSeconds: 100, avgSecondsToAnswer: 10 });
    expect(mou).toMatchObject({ answered: 1, outbound: 1, outboundConnected: 0, talkSeconds: 20, avgSecondsToAnswer: 30 });
  });

  test('per day (IST) covers every day of the range', () => {
    expect(r.perDay.map((d) => d.date)).toEqual(['2026-10-12', '2026-10-13']);
    expect(r.perDay[0]).toMatchObject({ inboundAnswered: 2, inboundMissed: 0, outbound: 0 });
    expect(r.perDay[1]).toMatchObject({ inboundAnswered: 0, inboundMissed: 2, outbound: 3 });
  });

  test('busy hours in IST', () => {
    expect(r.perHour[10].inbound).toBe(2); // 04:30Z and 05:00Z = 10:00 and 10:30 IST
    expect(r.perHour[17].inbound).toBe(1); // 12:00Z = 17:30 IST
    expect(r.perHour[17].missed).toBe(1);
  });

  test('missed and not followed up list', () => {
    expect(r.notFollowedUp).toHaveLength(1);
    expect(r.notFollowedUp[0]).toMatchObject({ callLogId: '4', contactName: 'Bina', chatId: 'c4', assignedTo: [] });
  });

  test('range parsing: IST days, default 7 days, swapped and capped', () => {
    const p = parseRange({ from: '2026-10-12', to: '2026-10-13' });
    expect(p.from.toISOString()).toBe('2026-10-11T18:30:00.000Z');
    expect(p.to.toISOString()).toBe('2026-10-13T18:29:59.999Z');
    const now = t('2026-10-20T00:00:00Z');
    expect(parseRange({}, now).from.toISOString()).toBe('2026-10-13T00:00:00.000Z');
    const s = parseRange({ from: '2026-10-13', to: '2026-10-12' });
    expect(s.from < s.to).toBe(true);
    const capped = parseRange({ from: '2020-01-01', to: '2026-10-12' });
    expect((capped.to - capped.from) / 86400e3).toBeLessThanOrEqual(366);
  });

  test('CSV: IST time, results, formula-safe, Excel BOM', () => {
    const csv = toCsv([calls[0], calls[3], calls[6], { ...calls[3], metadata: { contactName: '=HYPERLINK("x")' } }], users);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toContain('Date (IST)');
    expect(lines[1]).toBe('2026-10-12 10:00:00,Incoming,Answered,,"=""+911""",Rina,10,60,');
    expect(lines[2]).toContain('Incoming,Missed,Bina,"=""+914"""');
    expect(lines[3]).toContain('Outgoing,Not allowed');
    expect(lines[4]).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
