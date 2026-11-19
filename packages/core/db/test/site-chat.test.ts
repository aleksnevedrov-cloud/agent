import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountsRepo, normalizeRuPhone, phoneKey, SiteChatRepo, type Db } from '../src/index.ts';
import { freshDb } from './setup.ts';

let db: Db;
let drop: () => Promise<void>;
let repo: SiteChatRepo;
const ACC = 31337;

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await new AccountsRepo(db).upsertInstalled({ id: ACC, subdomain: 'acc', accountDomain: 'acc.amocrm.ru' });
  repo = new SiteChatRepo(db);
});
afterAll(async () => drop());

describe('normalizeRuPhone (RFD-SITE-CHAT-AGENT)', () => {
  it('8, +7 и 10 цифр — один номер; остальное — null', () => {
    expect(normalizeRuPhone('+7 (926) 123-45-67')).toBe('79261234567');
    expect(normalizeRuPhone('8 926 123 45 67')).toBe('79261234567');
    expect(normalizeRuPhone('9261234567')).toBe('79261234567');
    expect(normalizeRuPhone('+1 202 555 0100')).toBeNull();
    expect(normalizeRuPhone('12345')).toBeNull();
    expect(phoneKey('+7 (926) 123-45-67')).toBe('9261234567');
  });
});

describe('SiteChatRepo', () => {
  const base = { accountId: ACC, name: 'Павел', phone: '79261234567', email: 'p@example.com', consentAt: new Date(), ip: '10.0.0.1' };

  it('сессия, сообщения, лимиты по IP и дубль формы', async () => {
    const s = await repo.create({ ...base, pageUrl: 'https://www.rf-dveri.ru/catalog/', utm: { utm_source: 'yandex' } });
    expect(s.id).toHaveLength(32);
    expect(s.state).toBe('active');
    expect(s.amoSync).toBe('pending');
    await repo.addMessage(s.id, 'client', 'дверь-книжка 340+340, высота 2000, Дуб Сонома');
    await repo.addMessage(s.id, 'agent', 'Здравствуйте! Подберу варианты.', { costRub: 3.48, products: [{ id: '1', name: 'Дверь', price: 14190, url: 'https://rf-dveri.ru/d/1', picture: null }] });
    const msgs = await repo.messages(s.id);
    expect(msgs.map((m) => m.author)).toEqual(['client', 'agent']);
    expect(msgs[1]?.products[0]).toMatchObject({ price: 14190 });
    expect(await repo.countMessages(s.id, 'agent')).toBe(1);
    expect(await repo.costToday(ACC)).toBeCloseTo(3.48);
    expect(await repo.countByIp('10.0.0.1', 10 * 60_000)).toBe(1);
    expect(await repo.findDuplicate(ACC, '79261234567', 'дверь-книжка 340+340, высота 2000, Дуб Сонома', 10 * 60_000)).toMatchObject({ id: s.id });
    expect(await repo.findDuplicate(ACC, '79261234567', 'другой текст', 10 * 60_000)).toBeNull();
    // Спам в amoCRM не идёт и в очереди синхронизации не появляется.
    const spam = await repo.create({ ...base, state: 'spam' });
    expect(spam.amoSync).toBe('failed');
    expect((await repo.dueForSync()).map((x) => x.id)).toEqual([s.id]);
  });

  it('синхронизация: заявка, примечания, сводка, задача; повторы 1/5/15/60 минут и failed после 4 неудач', async () => {
    const now = new Date('2026-11-19T10:00:00Z');
    const s = await repo.create({ ...base, phone: '79990000001' });
    const m = await repo.addMessage(s.id, 'client', 'привет');
    // Неудача → повтор через 1 минуту, затем 5, 15, 60; после четвёртой — failed.
    let r = await repo.markSyncFailed(s.id, 'HTTP 500', now);
    expect(r).toEqual({ failed: false, attempts: 1 });
    expect((await repo.get(s.id))?.amoNextTryAt).toEqual(new Date(now.getTime() + 60_000));
    expect((await repo.dueForSync(now)).some((x) => x.id === s.id)).toBe(false);
    expect((await repo.dueForSync(new Date(now.getTime() + 61_000))).some((x) => x.id === s.id)).toBe(true);
    r = await repo.markSyncFailed(s.id, 'HTTP 500', now);
    expect((await repo.get(s.id))?.amoNextTryAt).toEqual(new Date(now.getTime() + 5 * 60_000));
    r = await repo.markSyncFailed(s.id, 'HTTP 500', now);
    expect((await repo.get(s.id))?.amoNextTryAt).toEqual(new Date(now.getTime() + 15 * 60_000));
    r = await repo.markSyncFailed(s.id, 'HTTP 500', now);
    expect(r).toEqual({ failed: true, attempts: 4 });
    expect((await repo.get(s.id))?.amoSync).toBe('failed');

    // Успех: заявка создана, примечание записано, сводка и задача ждут очереди.
    await repo.markLeadCreated(s.id, { uid: 'u-1', leadId: 500, contactId: 77 });
    await repo.markMessagesSynced([m.id], 9001);
    expect((await repo.messages(s.id))[0]).toMatchObject({ amoNoteId: 9001, amoSync: 'sent' });
    await repo.setSummary(s.id, 'Ищет дверь-книжку', { task: true });
    let got = await repo.get(s.id);
    expect(got).toMatchObject({ amoSync: 'sent', amoLeadId: 500, amoContactId: 77, summarySync: 'pending', taskSync: 'pending', amoAttempts: 0 });
    expect((await repo.dueForSync(new Date())).some((x) => x.id === s.id)).toBe(true);
    await repo.markSummarySynced(s.id, 9002);
    await repo.markTaskSynced(s.id, 42);
    got = await repo.get(s.id);
    expect(got).toMatchObject({ summarySync: 'sent', summaryNoteId: 9002, taskSync: 'sent', taskId: 42 });
    expect((await repo.dueForSync(new Date())).some((x) => x.id === s.id)).toBe(false);
    // Повторная сводка обновляет то же примечание: снова pending, note_id сохранён.
    await repo.setSummary(s.id, 'Ищет дверь-книжку, 2 шт.');
    got = await repo.get(s.id);
    expect(got).toMatchObject({ summarySync: 'pending', summaryNoteId: 9002, taskSync: 'sent' });
  });

  it('простой: активные сессии с сообщением клиента старше N минут; состояния', async () => {
    const s = await repo.create({ ...base, phone: '79990000002' });
    await repo.addMessage(s.id, 'client', 'ау');
    const empty = await repo.create({ ...base, phone: '79990000003' });
    const later = new Date(Date.now() + 11 * 60_000);
    const idle = await repo.idle(ACC, 10 * 60_000, later);
    expect(idle.some((x) => x.id === s.id)).toBe(true);
    expect(idle.some((x) => x.id === empty.id)).toBe(false);
    await repo.setState(s.id, 'closed');
    expect(await repo.get(s.id)).toMatchObject({ state: 'closed' });
    expect((await repo.get(s.id))?.closedAt).not.toBeNull();
    await repo.setState(empty.id, 'handed_off', 'client_request');
    expect(await repo.get(empty.id)).toMatchObject({ state: 'handed_off', handoffReason: 'client_request' });
    expect((await repo.idle(ACC, 10 * 60_000, later)).some((x) => x.id === s.id)).toBe(false);
    const list = await repo.list(ACC);
    expect(list.find((x) => x.id === s.id)?.messages).toBe(1);
  });
});
