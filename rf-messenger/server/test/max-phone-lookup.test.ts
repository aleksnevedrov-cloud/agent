/* eslint-disable @typescript-eslint/no-explicit-any -- в тестах разбираем произвольный JSON запросов */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmoRest, type AmoRest as AmoRestType } from '../src/amo/rest.ts';
import type { ContactCandidate } from '../src/amo/contact-match.ts';
import { Bridge, type Logger } from '../src/bridge.ts';
import { MaxGreenApiConnector } from '../src/connectors/max-greenapi.ts';
import type { Channel } from '../src/store.ts';
import { ACCOUNT, event, FakeConnector, setupBridge } from './helpers.ts';

/**
 * RFD-MESSENGER (ТЗ 22.11.2026): чат MAX по номеру без номера в вебхуке — номер запрашивается у GREEN-API,
 * затем обычная привязка по номеру; без номера — поиск по полю Wazzup (если включён).
 */

const PHONE = '+79361472324';
const CHAT_ID = '10001028';
const cand = (over: Partial<ContactCandidate>): ContactCandidate => ({ id: 1, name: 'Алексей', phones: [PHONE], updatedAt: 100, leads: [], ...over });

/** Коннектор MAX в тесте: номер по чату (null — нет), ошибка или задержка по требованию. */
class FakeMaxConnector extends FakeConnector {
  phoneByChat = new Map<string, string | null>();
  lookups: string[] = [];
  lookupFail: Error | null = null;
  lookupDelayMs = 0;
  async lookupPhone(externalChatId: string): Promise<string | null> {
    this.lookups.push(externalChatId);
    if (this.lookupDelayMs) await new Promise((r) => setTimeout(r, this.lookupDelayMs));
    if (this.lookupFail) throw this.lookupFail;
    return this.phoneByChat.get(externalChatId) ?? null;
  }
}

function restStub(byPhone: ContactCandidate[], byField: ContactCandidate[], calls: string[]): AmoRestType {
  return {
    contactsByPhone: async (_a: number, phone: string) => {
      calls.push(`phone:${phone}`);
      return byPhone;
    },
    contactsByField: async (_a: number, field: string, value: string) => {
      calls.push(`field:${field}=${value}`);
      return byField;
    },
    linkChat: async (_a: number, chatId: string, contactId: number) => void calls.push(`link:${contactId}`),
    contact: async (_a: number, id: number) => ({ id, name: 'Из сделки', phones: [] }),
    userAmojoId: async () => 'op-1',
    userName: async () => 'Мария',
  } as unknown as AmoRestType;
}

let t: Awaited<ReturnType<typeof setupBridge>>;
let max: Channel;
let conn: FakeMaxConnector;
let lines: { level: string; msg: string; obj: Record<string, unknown> }[];
let log: Logger;
let now: number;

beforeEach(async () => {
  t = await setupBridge();
  lines = [];
  log = {
    info: (o, m) => void lines.push({ level: 'info', msg: m ?? '', obj: o as Record<string, unknown> }),
    warn: (o, m) => void lines.push({ level: 'warn', msg: m ?? '', obj: o as Record<string, unknown> }),
    error: (o, m) => void lines.push({ level: 'error', msg: m ?? '', obj: o as Record<string, unknown> }),
  };
  max = (await t.store.createChannel({ accountId: ACCOUNT, kind: 'max_phone', title: 'MAX по номеру', externalId: 'ga-1', credentials: t.box.encrypt('{}') }))!;
  await t.store.setChannelStatus(max.id, 'connected');
  conn = new FakeMaxConnector();
  now = 1_800_000_000_000;
});
afterEach(async () => {
  await t.drop();
});

const bridgeWith = (rest: AmoRestType, over: Record<string, unknown> = {}) =>
  new Bridge({ ...t.bridgeDeps, log, rest, now: () => now, connector: (id) => (id === max.id ? conn : id === t.channel.id ? t.connector : undefined), ...over });
const inbound = (bridge: Bridge, id: string, over: Record<string, unknown> = {}) => bridge.onInbound(max, conn, event({ externalChatId: CHAT_ID, externalMessageId: id, contact: {}, ...over }));
const lastJob = () => t.queue.jobs.at(-1)!.data.messageId;
const amoPaths = () => t.calls.map((c) => c.path.replace('/v2/origin/custom/scope-xyz', ''));

describe('MAX без номера в вебхуке: номер у GREEN-API → привязка по номеру', () => {
  it('номер получен → сохранён в chats.contact, контакт найден по номеру, createChat → linkChat → сообщение; журнал без полного номера', async () => {
    const calls: string[] = [];
    conn.phoneByChat.set(CHAT_ID, PHONE);
    const bridge = bridgeWith(restStub([cand({ id: 65167009 })], [], calls));
    await inbound(bridge, 'm1');
    await bridge.deliverToAmo(lastJob());
    expect(conn.lookups).toEqual([CHAT_ID]);
    expect(calls).toEqual([`phone:${PHONE}`, 'link:65167009']);
    expect(amoPaths()).toEqual(['/chats', '']);
    const chat = await t.store.chatByExternal(max.id, CHAT_ID);
    expect(chat?.contact.phone).toBe(PHONE);
    expect(chat?.amojoChatId).toBeTruthy();
    const got = lines.find((l) => l.msg.includes('номер собеседника MAX получен'))!.obj;
    expect(got).toMatchObject({ channel: 'max_phone', result: 'номер получен', phone: '…2324' });
    expect(JSON.stringify(lines)).not.toContain('9361472324');
    // Профиль клиента в amo — с телефоном.
    expect((t.calls.at(-1)!.body.payload as any).sender.profile).toEqual({ phone: PHONE });
    // Второе сообщение: номер уже есть, привязка есть — ни запроса номера, ни поиска.
    await inbound(bridge, 'm2');
    await bridge.deliverToAmo(lastJob());
    expect(conn.lookups).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('phone:'))).toHaveLength(1);
  });

  it('phoneNumber = 0 (номера нет) → как сейчас: сообщение в amo без привязки, в журнале «номера нет»; после ответа amo чат считается привязанным и номер больше не запрашивается', async () => {
    const calls: string[] = [];
    conn.phoneByChat.set(CHAT_ID, null);
    const bridge = bridgeWith(restStub([cand({})], [], calls));
    await inbound(bridge, 'm1');
    await bridge.deliverToAmo(lastJob());
    expect(amoPaths()).toEqual(['']);
    expect(calls).toEqual([]);
    expect(lines.find((l) => l.obj.result === 'номера нет')?.obj).toMatchObject({ channel: 'max_phone' });
    // amo создал чат (неразобранное с новым контактом) — дальше чат с привязкой, запросов нет (п. 2.6).
    now += 11 * 60_000;
    await inbound(bridge, 'm2');
    await bridge.deliverToAmo(lastJob());
    expect(conn.lookups).toEqual([CHAT_ID]);
  });

  it('повтор запроса по одному чату — не чаще раза в 10 минут (пока чат не ушёл в amo)', async () => {
    conn.phoneByChat.set(CHAT_ID, null);
    const bridge = bridgeWith(restStub([cand({})], [], []));
    await inbound(bridge, 'm1');
    const chat = (await t.store.chatByExternal(max.id, CHAT_ID))!;
    expect(await bridge.resolveUnknownPhone(chat)).toBe('none');
    now += 5 * 60_000;
    expect(await bridge.resolveUnknownPhone(chat)).toBe('skipped');
    now += 5 * 60_000 + 1;
    conn.phoneByChat.set(CHAT_ID, PHONE);
    expect(await bridge.resolveUnknownPhone(chat)).toBe('found');
    expect(conn.lookups).toEqual([CHAT_ID, CHAT_ID]);
    expect((await t.store.chatByExternal(max.id, CHAT_ID))?.contact.phone).toBe(PHONE);
  });

  it('таймаут или ошибка GREEN-API → сообщение доставлено без привязки, предупреждение в журнале', async () => {
    const calls: string[] = [];
    conn.lookupDelayMs = 60;
    const bridge = bridgeWith(restStub([cand({})], [], calls), { contactLookupTimeoutMs: 20 });
    await inbound(bridge, 'm1');
    const chat = (await t.store.chatByExternal(max.id, CHAT_ID))!;
    expect(await bridge.resolveUnknownPhone(chat)).toBe('failed');
    expect(lines.find((l) => l.level === 'warn')?.msg).toContain('номер собеседника MAX не получен');
    expect(lines.find((l) => l.level === 'warn')?.obj.err).toContain('нет ответа за');
    conn.lookupDelayMs = 0;
    conn.lookupFail = new Error('GREEN-API getContactInfo: HTTP 500');
    now += 11 * 60_000;
    expect(await bridge.resolveUnknownPhone(chat)).toBe('failed');
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(2);
    // Сообщение не теряется: уходит в amo как раньше.
    await bridge.deliverToAmo(lastJob());
    expect(amoPaths()).toEqual(['']);
    expect(calls).toEqual([]);
    expect((await t.store.messageById(lastJob()))?.amojoMsgid).toBeTruthy();
  });

  it('группа MAX и другие каналы — запроса номера нет', async () => {
    const bridge = bridgeWith(restStub([cand({})], [], []));
    await bridge.onInbound(max, conn, event({ externalChatId: '-500', isGroup: true, externalMessageId: 'g1', contact: {}, author: { id: '1', name: 'А' } }));
    await bridge.deliverToAmo(lastJob());
    await bridge.onInbound(t.channel, t.connector, event({ externalChatId: 'tg1', externalMessageId: 't1', contact: { username: 'ivan' } }));
    await bridge.deliverToAmo(lastJob());
    expect(conn.lookups).toEqual([]);
  });

  it('«Написать» из сделки имеет приоритет: у чата уже есть привязка — номер не запрашивается, поиска нет', async () => {
    const calls: string[] = [];
    const bridge = bridgeWith(restStub([cand({ id: 1 })], [], calls));
    conn.phones.set(PHONE, CHAT_ID);
    await bridge.startChat({ accountId: ACCOUNT, userId: 5, channelId: max.id, contactId: 777, phone: PHONE, text: 'Добрый день' });
    expect(calls.find((c) => c.startsWith('link:'))).toBe('link:777');
    await inbound(bridge, 'r1');
    await bridge.deliverToAmo(lastJob());
    expect(conn.lookups).toEqual([]);
    expect(calls.filter((c) => c.startsWith('phone:') || c.startsWith('field:'))).toEqual([]);
  });
});

describe('п. 2.4: номера нет → поиск по полю с id собеседника MAX (только если поле задано)', () => {
  it('поле не задано → поиска по полю нет; задано → точное совпадение chatId, привязка с причиной в журнале', async () => {
    conn.phoneByChat.set(CHAT_ID, null);
    const off: string[] = [];
    await inbound(bridgeWith(restStub([], [cand({ id: 9 })], off)), 'm0');
    await bridgeWith(restStub([], [cand({ id: 9 })], off)).deliverToAmo(lastJob());
    expect(off).toEqual([]);
    const calls: string[] = [];
    const bridge = bridgeWith(restStub([], [cand({ id: 9, name: 'АЛЕКСЕЙ', phones: [] })], calls), { maxIdField: 'MaxId_WZ' });
    await bridge.onInbound(max, conn, event({ externalChatId: '20002000', externalMessageId: 'n1', contact: {} }));
    await bridge.deliverToAmo(lastJob());
    expect(calls).toEqual(['field:MaxId_WZ=20002000', 'link:9']);
    const line = lines.find((l) => l.msg === 'чат привязан к контакту amoCRM')!.obj;
    expect(line).toMatchObject({ contactId: 9, field: 'MaxId_WZ' });
    expect(String(line.reason)).toContain('найден по MaxId_WZ');
    expect((await t.store.chatByExternal(max.id, '20002000'))?.amojoChatId).toBeTruthy();
  });

  it('по полю не найден → неразобранное как сейчас, в журнале «не найден»', async () => {
    conn.phoneByChat.set(CHAT_ID, null);
    const calls: string[] = [];
    const bridge = bridgeWith(restStub([], [], calls), { maxIdField: 'MaxId_WZ' });
    await inbound(bridge, 'm1');
    await bridge.deliverToAmo(lastJob());
    expect(calls).toEqual([`field:MaxId_WZ=${CHAT_ID}`]);
    expect(amoPaths()).toEqual(['']);
    expect(lines.find((l) => l.obj.result === 'не найден')?.obj).toMatchObject({ field: 'MaxId_WZ', channel: 'max_phone' });
  });
});

describe('GREEN-API: lookupPhone и REST contactsByField', () => {
  const CREDS = { idInstance: '1101000001', apiTokenInstance: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6ab' };
  const gaFetch = (log: string[], respond: (method: string, body: unknown) => unknown) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const method = u.pathname.split('/')[2] ?? '';
      log.push(`${init?.method ?? 'GET'} ${method}`);
      const r = respond(method, init?.body ? JSON.parse(String(init.body)) : null);
      if (r instanceof Error) return new Response(JSON.stringify({ message: r.message }), { status: 500 });
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  const deps = { onQr: async () => undefined, onIdentity: async () => true };

  it('getContactInfo с номером → +7…; phoneNumber 0 → getChats по id чата; оба без номера → null; обе ошибки → исключение; токен не в ошибке', async () => {
    const a: string[] = [];
    const c1 = new MaxGreenApiConnector(CREDS, { ...deps, fetch: gaFetch(a, (m, body) => (m === 'getContactInfo' ? { chatId: (body as any).chatId, phoneNumber: 79361472324 } : [])) });
    expect(await c1.lookupPhone(CHAT_ID)).toBe(PHONE);
    expect(a).toEqual(['POST getContactInfo']);
    const b: string[] = [];
    const c2 = new MaxGreenApiConnector(CREDS, { ...deps, fetch: gaFetch(b, (m) => (m === 'getContactInfo' ? { phoneNumber: 0 } : [{ id: '77', phoneNumber: '79990000000' }, { id: CHAT_ID, name: 'Алексей', phoneNumber: '79361472324' }])) });
    expect(await c2.lookupPhone(CHAT_ID)).toBe(PHONE);
    expect(b).toEqual(['POST getContactInfo', 'GET getChats']);
    const c3 = new MaxGreenApiConnector(CREDS, { ...deps, fetch: gaFetch([], (m) => (m === 'getContactInfo' ? {} : [{ id: CHAT_ID, phoneNumber: 0 }])) });
    expect(await c3.lookupPhone(CHAT_ID)).toBeNull();
    const c4 = new MaxGreenApiConnector(CREDS, { ...deps, fetch: gaFetch([], () => new Error('boom')) });
    const err = await c4.lookupPhone(CHAT_ID).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 500/);
    expect((err as Error).message).not.toContain(CREDS.apiTokenInstance);
  });

  it('contactsByField: query по значению, точное совпадение по имени поля, сделки одним запросом', async () => {
    const urls: string[] = [];
    const f = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      urls.push(u.pathname + u.search);
      if (u.pathname === '/api/v4/contacts')
        return new Response(
          JSON.stringify({
            _embedded: {
              contacts: [
                { id: 1, name: 'Точный', updated_at: 10, custom_fields_values: [{ field_name: 'MaxId_WZ', values: [{ value: ' 10001028 ' }] }, { field_code: 'PHONE', values: [{ value: '+7 999 1' }] }], _embedded: { leads: [{ id: 11 }] } },
                { id: 2, name: 'Похожий', updated_at: 20, custom_fields_values: [{ field_name: 'MaxId_WZ', values: [{ value: '100010281' }] }] },
                { id: 3, name: 'Другое поле', updated_at: 30, custom_fields_values: [{ field_name: 'MaxUsername_WZ', values: [{ value: '10001028' }] }] },
              ],
            },
          }),
        );
      if (u.pathname === '/api/v4/leads') return new Response(JSON.stringify({ _embedded: { leads: [{ id: 11, status_id: 50, updated_at: 500 }] } }));
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const rest = new AmoRest(t.db, t.box, { clientId: 'c', clientSecret: 's', redirectUri: 'https://x/', allowedDomains: ['amocrm.ru'], fetch: f });
    await t.db.query("INSERT INTO amo_oauth (account_id, base_domain, access_token, refresh_token, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')", [ACCOUNT, 'x.amocrm.ru', t.box.encrypt('a'), t.box.encrypt('r')]);
    const r = await rest.contactsByField(ACCOUNT, 'MaxId_WZ', CHAT_ID);
    expect(urls).toEqual(['/api/v4/contacts?query=10001028&with=leads&limit=50', '/api/v4/leads?filter[id][]=11&limit=50']);
    expect(r).toEqual([{ id: 1, name: 'Точный', phones: ['+7 999 1'], updatedAt: 10, leads: [{ id: 11, statusId: 50, updatedAt: 500 }] }]);
    expect(await rest.contactsByField(ACCOUNT, '', CHAT_ID)).toEqual([]);
  });
});

describe('RFD-MESSENGER 23.11: пометка контакта id собеседника MAX и перенос чата в сделку', () => {
  const restWithMark = (calls: string[], over: Record<string, unknown> = {}) =>
    ({
      ...(restStub([cand({ id: 65167009 })], [], calls) as unknown as Record<string, unknown>),
      setContactField: async (_a: number, contactId: number, field: string, value: string) => {
        calls.push(`mark:${contactId}:${field}=${value}`);
        return 'set';
      },
      leadContacts: async (_a: number, leadId: number) => (leadId === 777 ? [{ id: 555, name: 'Старый клиент', phones: [] }] : []),
      relinkChat: async (_a: number, _chat: string, contactId: number) => void calls.push(`relink:${contactId}`),
      ...over,
    }) as unknown as AmoRestType;

  it('привязка по номеру → контакт помечается id собеседника MAX (поле MAX_ID_FIELD)', async () => {
    const calls: string[] = [];
    conn.phoneByChat.set(CHAT_ID, PHONE);
    const bridge = bridgeWith(restWithMark(calls), { maxIdField: 'MaxId_WZ' });
    await inbound(bridge, 'm1');
    await bridge.deliverToAmo(lastJob());
    expect(calls).toEqual([`phone:${PHONE}`, 'link:65167009', `mark:65167009:MaxId_WZ=${CHAT_ID}`]);
    expect(lines.some((l) => l.msg === 'контакт помечен id собеседника MAX')).toBe(true);
  });

  it('без MAX_ID_FIELD, для групп и не-MAX каналов — пометки нет; ошибка пометки не мешает переписке', async () => {
    const calls: string[] = [];
    conn.phoneByChat.set(CHAT_ID, PHONE);
    await inbound(bridgeWith(restWithMark(calls)), 'm1');
    await bridgeWith(restWithMark(calls)).deliverToAmo(lastJob());
    expect(calls.some((c) => c.startsWith('mark:'))).toBe(false);
    // Не-MAX канал: чат Telegram/WhatsApp не помечается даже с полем.
    const tg = (await t.store.upsertChat(t.channel, { externalChatId: '42', isGroup: false, title: 'TG', contact: {} }))!;
    expect(await bridgeWith(restWithMark(calls), { maxIdField: 'MaxId_WZ' }).markMaxContact(tg, 1)).toBe('skipped');
    // Ошибка amo при пометке → 'failed', в журнал предупреждение.
    const failing = bridgeWith(restWithMark(calls, { setContactField: async () => { throw new Error('HTTP 500'); } }), { maxIdField: 'MaxId_WZ' });
    const chat = (await t.store.chatByExternal(max.id, CHAT_ID))!;
    expect(await failing.markMaxContact(chat, 1)).toBe('failed');
    expect(lines.some((l) => l.level === 'warn' && l.msg === 'контакт не помечен id собеседника MAX')).toBe(true);
  });

  it('перенос в сделку: чат → к основному контакту сделки (relinkChat), контакт помечается; сделка без контакта — понятная ошибка', async () => {
    const calls: string[] = [];
    conn.phoneByChat.set(CHAT_ID, null);
    const bridge = bridgeWith(restWithMark(calls), { maxIdField: 'MaxId_WZ' });
    await inbound(bridge, 'm1');
    await bridge.deliverToAmo(lastJob()); // дубль: ушло без привязки
    const chat = (await t.store.chatByExternal(max.id, CHAT_ID))!;
    const r = await bridge.moveChatToLead({ accountId: ACCOUNT, chatId: chat.id, leadId: 777 });
    expect(r).toEqual({ contactId: 555, contactName: 'Старый клиент', marked: true });
    expect(calls.slice(-2)).toEqual(['relink:555', `mark:555:MaxId_WZ=${CHAT_ID}`]);
    expect((await t.store.chatById(chat.id))?.amojoChatId).toBeTruthy();
    await expect(bridge.moveChatToLead({ accountId: ACCOUNT, chatId: chat.id, leadId: 1 })).rejects.toThrow('нет контакта');
    await expect(bridge.moveChatToLead({ accountId: ACCOUNT + 1, chatId: chat.id, leadId: 777 })).rejects.toThrow('Чат не найден');
  });

  it('AmoRest: setContactField пишет только новое значение; relinkChat проверяет результат и при отказе amo — 409 с подсказкой', async () => {
    const urls: string[] = [];
    let linkedTo = 1;
    let moves = true;
    let fieldVal = '';
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const m = init?.method ?? 'GET';
      urls.push(`${m} ${u.pathname}`);
      if (u.pathname === '/api/v4/contacts/custom_fields') return new Response(JSON.stringify({ _embedded: { custom_fields: [{ id: 734691, name: 'MaxId_WZ' }] } }));
      if (u.pathname === '/api/v4/contacts/555' && m === 'GET') return new Response(JSON.stringify({ id: 555, custom_fields_values: fieldVal ? [{ field_id: 734691, values: [{ value: fieldVal }] }] : null }));
      if (u.pathname === '/api/v4/contacts/555' && m === 'PATCH') {
        fieldVal = JSON.parse(String(init?.body)).custom_fields_values[0].values[0].value;
        return new Response('{}');
      }
      if (u.pathname === '/api/v4/contacts/chats' && m === 'GET') return new Response(JSON.stringify({ _embedded: { chats: [{ contact_id: linkedTo }] } }));
      if (u.pathname === '/api/v4/contacts/chats' && m === 'POST') {
        if (moves) linkedTo = 555;
        return new Response('{}');
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const rest = new AmoRest(t.db, t.box, { clientId: 'c', clientSecret: 's', redirectUri: 'https://x/', allowedDomains: ['amocrm.ru'], fetch: f });
    await t.db.query("INSERT INTO amo_oauth (account_id, base_domain, access_token, refresh_token, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')", [ACCOUNT, 'x.amocrm.ru', t.box.encrypt('a'), t.box.encrypt('r')]);
    expect(await rest.setContactField(ACCOUNT, 555, 'MaxId_WZ', CHAT_ID)).toBe('set');
    expect(fieldVal).toBe(CHAT_ID);
    expect(await rest.setContactField(ACCOUNT, 555, 'MaxId_WZ', CHAT_ID)).toBe('same');
    expect(await rest.setContactField(ACCOUNT, 555, 'Нет такого', CHAT_ID)).toBe('nofield');
    expect(urls.filter((x) => x.startsWith('PATCH'))).toHaveLength(1);
    await rest.relinkChat(ACCOUNT, 'amo-chat', 555);
    expect(linkedTo).toBe(555);
    linkedTo = 1;
    moves = false;
    await expect(rest.relinkChat(ACCOUNT, 'amo-chat', 555)).rejects.toMatchObject({ status: 409 });
  });
});
