/* eslint-disable @typescript-eslint/no-explicit-any -- в тестах разбираем произвольный JSON */
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectProblems, dailySummaryText, restartText, AlertNotifier } from '../src/alerts.ts';
import type { AmoRest } from '../src/amo/rest.ts';
import { Bridge } from '../src/bridge.ts';
import { PermanentSendError } from '../src/connectors/types.ts';
import type { ChatEvent } from '../src/events.ts';
import { BullJobQueue, channelQueueName, MEDIA_QUEUE_NAME, QUEUE_NAME, startTicketKey } from '../src/queue.ts';
import { ChannelWorkers, dailySummaryDue } from '../src/workers.ts';
import { ACCOUNT, event, FakeConnector, setupBridge, silent, TEST_REDIS_URL } from './helpers.ts';

let redis: Redis;
beforeAll(() => {
  redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
});
afterAll(async () => {
  await redis.quit();
});

let t: Awaited<ReturnType<typeof setupBridge>>;
let events: ChatEvent[];
let bridge: Bridge;
const rest = {
  userName: async () => 'Мария Менеджер',
  userAmojoId: async () => 'amojo-user-7',
  contact: async (_a: number, id: number) => ({ id, name: 'Иван', phones: [] }),
  linkChat: async () => undefined,
} as unknown as AmoRest;

beforeEach(async () => {
  t = await setupBridge();
  events = [];
  bridge = new Bridge({ ...t.bridgeDeps, rest, events: { publish: async (_a, ev) => void events.push(ev) } });
  await t.store.setChannelStatus(t.channel.id, 'connected');
});
afterEach(async () => {
  await t.drop();
});

const windowInput = (chatId: number, text = 'Едем на замер') => ({ accountId: ACCOUNT, userId: 7, chatId, text });
async function clientChat() {
  await bridge.onInbound(t.channel, t.connector, event({ text: 'Привет' }));
  return (await t.store.recentChats(ACCOUNT, t.channel.id))[0]!;
}

describe('4.1 отправка без ожидания в HTTP', () => {
  it('queueFromWindow: сообщение сохраняется «в очереди» и возвращается сразу, коннектор не вызывается; исполнитель отправляет, шлёт статус по SSE и передаёт в amo', async () => {
    const chat = await clientChat();
    const started = Date.now();
    const r = await bridge.queueFromWindow(windowInput(chat.id));
    expect(Date.now() - started).toBeLessThan(1000);
    const msg = (await t.store.messageById(r.messageIds[0]!))!;
    expect(msg).toMatchObject({ direction: 'out', source: 'phone', status: 'queued', externalId: null, senderName: 'Мария Менеджер', senderUserId: 7 });
    expect(t.connector.sent).toHaveLength(0);
    const job = t.queue.jobs.find((j) => j.name === 'to-channel')!;
    expect(job.data).toMatchObject({ messageId: msg.id, channelId: t.channel.id });
    expect(job.data.deadline).toBeGreaterThan(Date.now() + 100_000);
    // Ответ из окна закрыл неотвеченные ещё до отправки.
    expect(events.filter((e) => e.type === 'counters').at(-1)).toMatchObject({ unanswered: 0, answered: 1 });
    expect(events.some((e) => e.type === 'message' && e.messageId === msg.id)).toBe(true);

    await bridge.deliverToChannel(msg.id, true, job.data.deadline ?? null);
    expect(t.connector.sent).toMatchObject([{ externalChatId: '42', text: 'Едем на замер', idempotencyKey: `rfm-m${msg.id}` }]);
    const sent = (await t.store.messageById(msg.id))!;
    expect(sent.externalId).toBe('1001');
    expect(sent.sentAt).not.toBeNull();
    expect(sent.status).toBe('synced'); // отправлено и передано в amo
    expect(events.some((e) => e.type === 'status' && e.messageId === msg.id && e.status === 'sent')).toBe(true);
    const amo = t.calls.at(-1)!.body.payload as Record<string, any>;
    expect(amo.sender).toEqual({ ref_id: 'amojo-user-7' });
    expect(amo.message).toEqual({ type: 'text', text: 'Едем на замер' });
  });

  it('канал не подключён — ошибка сразу с названием канала; пустое — ошибка', async () => {
    const chat = await clientChat();
    await t.store.setChannelStatus(t.channel.id, 'no_phone');
    await expect(bridge.queueFromWindow(windowInput(chat.id))).rejects.toThrow(/Telegram-бот сейчас не подключён/);
    await expect(bridge.queueFromWindow(windowInput(chat.id, '  '))).rejects.toThrow(/Пустое/);
  });
});

describe('4.3 и 4.7: таймаут, срок, ошибка с причиной, повтор', () => {
  it('мессенджер не отвечает — через sendTimeoutMs ошибка «<канал> не ответил»; на последней попытке — статус «ошибка» в окне', async () => {
    const chat = await clientChat();
    t.connector.send = () => new Promise(() => undefined);
    const b = new Bridge({ ...t.bridgeDeps, rest, sendTimeoutMs: 60, events: { publish: async (_a, ev) => void events.push(ev) } });
    const { messageIds } = await b.queueFromWindow(windowInput(chat.id));
    await expect(b.deliverToChannel(messageIds[0]!, false, null)).rejects.toThrow(/Telegram-бот не ответил/);
    expect((await t.store.messageById(messageIds[0]!))?.status).toBe('queued'); // очередь повторит
    await b.deliverToChannel(messageIds[0]!, true, null);
    const failed = (await t.store.messageById(messageIds[0]!))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/^Telegram-бот не ответил/);
    expect(events.filter((e) => e.type === 'status').at(-1)).toMatchObject({ status: 'failed', error: failed.error });
  });

  it('срок ожидания в очереди вышел — «ошибка» без обращения к мессенджеру; «Повторить» ставит заново с новым сроком', async () => {
    const chat = await clientChat();
    const { messageIds } = await bridge.queueFromWindow(windowInput(chat.id));
    const id = messageIds[0]!;
    await bridge.deliverToChannel(id, false, Date.now() - 1);
    expect(t.connector.sent).toHaveLength(0);
    const failed = (await t.store.messageById(id))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/Telegram-бот: сообщение не удалось отправить за 2 мин/);
    // Повтор доступен и для сообщений из окна (не только из amoCRM).
    expect(await bridge.retryMessage(ACCOUNT, id)).toBe(true);
    const retry = t.queue.jobs.filter((j) => j.name === 'to-channel').at(-1)!;
    expect(retry.jobId).toMatch(/-retry-/);
    expect(retry.data.channelId).toBe(t.channel.id);
    expect((await t.store.messageById(id))?.status).toBe('queued');
    await bridge.deliverToChannel(id, true, retry.data.deadline ?? null);
    expect(t.connector.sent).toHaveLength(1);
    expect((await t.store.messageById(id))?.status).toBe('synced');
    // Чужой аккаунт и входящие повторять нельзя.
    expect(await bridge.retryMessage(999, id)).toBe(false);
  });

  it('постоянная ошибка мессенджера приходит в окно с названием канала и без повторов', async () => {
    const chat = await clientChat();
    t.connector.failWith = new PermanentSendError('Клиент заблокировал бота');
    const { messageIds } = await bridge.queueFromWindow(windowInput(chat.id));
    await bridge.deliverToChannel(messageIds[0]!, false, null);
    expect((await t.store.messageById(messageIds[0]!))?.error).toBe('Telegram-бот: Клиент заблокировал бота');
  });
});

describe('4.2 изоляция каналов (настоящие очереди BullMQ)', () => {
  it('зависший канал А не задерживает отправку канала Б; «Написать» отвечает талоном, результат — в талоне', async () => {
    const slow = t.connector;
    slow.send = () => new Promise(() => undefined); // канал А повис
    const fast = new FakeConnector();
    const chB = (await t.store.createChannel({ accountId: ACCOUNT, kind: 'vk', title: 'VK', externalId: 'vk-1', credentials: t.box.encrypt('{}') }))!;
    await t.store.setChannelStatus(chB.id, 'connected');
    const queue = new BullJobQueue(redis);
    for (const name of [channelQueueName(t.channel.id), channelQueueName(chB.id)]) await queue.queue(name).obliterate({ force: true }).catch(() => undefined);
    const b = new Bridge({
      ...t.bridgeDeps,
      rest,
      queue,
      sendTimeoutMs: 5_000,
      connector: (id) => (id === t.channel.id ? slow : id === chB.id ? fast : undefined),
      events: { publish: async (_a, ev) => void events.push(ev) },
    });
    const logs: unknown[] = [];
    const log = { info: (o: object, m?: string) => logs.push([m, o]), warn: (o: object, m?: string) => logs.push([m, o]), error: (o: object, m?: string) => logs.push([m, o]) };
    const workers = new ChannelWorkers({ redis, bridge: b, log, concurrency: 1 });
    try {
      await workers.sync([t.channel.id, chB.id]);
      const chatA = await (async () => {
        await b.onInbound(t.channel, slow, event({ text: 'A' }));
        return (await t.store.recentChats(ACCOUNT, t.channel.id))[0]!;
      })();
      const chatB = await t.store.upsertChat(chB, { externalChatId: '77', isGroup: false, title: 'Клиент VK', contact: {} });
      // Две отправки в А занимают его единственного исполнителя и очередь; Б идёт своей очередью.
      await b.queueFromWindow(windowInput(chatA.id, 'A1'));
      await b.queueFromWindow(windowInput(chatA.id, 'A2'));
      const started = Date.now();
      const { messageIds } = await b.queueFromWindow(windowInput(chatB.id, 'B1'));
      for (let i = 0; i < 300 && fast.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      if (!fast.sent.length) logs.push(await queue.snapshot([channelQueueName(t.channel.id), channelQueueName(chB.id)]));
      expect(logs.filter((l) => Array.isArray(l) && String(l[0]).includes('не выполнена'))).toEqual([]);
      expect(fast.sent.map((s) => s.text)).toEqual(['B1']);
      expect(Date.now() - started).toBeLessThan(3_000); // канал А при этом висит (таймаут 5 с, 3 попытки)
      // Статус пишется сразу после ответа мессенджера — даём исполнителю мгновение.
      let status = (await t.store.messageById(messageIds[0]!))?.status;
      for (let i = 0; i < 60 && status === 'queued'; i++) {
        await new Promise((r) => setTimeout(r, 50));
        status = (await t.store.messageById(messageIds[0]!))?.status;
      }
      expect(status).toBe('synced');
      expect(slow.sent).toHaveLength(0);
      // «Написать» в канал Б: талон сразу, результат — по талону.
      const ticket = await queue.addStart({ accountId: ACCOUNT, userId: 7, channelId: chB.id, contactId: 1, chatId: chatB.id, text: 'Первое' });
      let raw: string | null = null;
      for (let i = 0; i < 100 && !raw; i++) {
        await new Promise((r) => setTimeout(r, 50));
        raw = await redis.get(startTicketKey(ticket));
      }
      expect(JSON.parse(raw!)).toMatchObject({ status: 'done', chatId: chatB.id, accountId: ACCOUNT });
      expect(fast.sent.map((s) => s.text)).toEqual(['B1', 'Первое']);
      // Ошибка «Написать» тоже попадает в талон.
      const bad = await queue.addStart({ accountId: ACCOUNT, userId: 7, channelId: chB.id, contactId: 1, chatId: chatB.id + 999, text: 'x' });
      let badRaw: string | null = null;
      for (let i = 0; i < 100 && !badRaw; i++) {
        await new Promise((r) => setTimeout(r, 50));
        badRaw = await redis.get(startTicketKey(bad));
      }
      expect(JSON.parse(badRaw!)).toMatchObject({ status: 'error', error: 'Чат не найден' });
      // Состояние очередей: у А задачи ждут/выполняются, у Б пусто.
      const snap = await queue.snapshot([channelQueueName(t.channel.id), channelQueueName(chB.id)]);
      expect(snap[0]!.active + snap[0]!.waiting).toBeGreaterThanOrEqual(1);
      expect(snap[1]).toMatchObject({ waiting: 0, active: 0 });
    } finally {
      await workers.close();
      for (const name of [channelQueueName(t.channel.id), channelQueueName(chB.id)]) await queue.queue(name).obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  }, 20_000);

  it('маршрутизация: to-channel — в очередь канала, media и history — в rfm-media, to-amo — в общую; задачи старого формата без канала — в общую', async () => {
    const queue = new BullJobQueue(redis, () => Date.now() + 5_000);
    const names = [channelQueueName(123456), MEDIA_QUEUE_NAME, QUEUE_NAME];
    for (const n of names) await queue.queue(n).drain(true).catch(() => undefined);
    try {
      expect(queue.queueFor('to-channel', { messageId: 1, channelId: 123456 }).name).toBe('rfm-ch-123456');
      expect(queue.queueFor('to-channel', { messageId: 1 }).name).toBe(QUEUE_NAME);
      expect(queue.queueFor('media', { messageId: 1, channelId: 5 }).name).toBe(MEDIA_QUEUE_NAME);
      expect(queue.queueFor('history', { messageId: 0, chatId: 5 }).name).toBe(MEDIA_QUEUE_NAME);
      expect(queue.queueFor('to-amo', { messageId: 1 }).name).toBe(QUEUE_NAME);
      expect(queue.queueFor('to-amo-media', { messageId: 1 }).name).toBe(QUEUE_NAME);
      await queue.add('to-channel', { messageId: 1, channelId: 123456 }, { jobId: `t-${Date.now()}` });
      const snap = await queue.snapshot([channelQueueName(123456)]);
      expect(snap[0]).toMatchObject({ name: 'rfm-ch-123456', waiting: 1, active: 0 });
      expect(snap[0]!.oldestWaitingSec).toBeGreaterThanOrEqual(4); // «сейчас» в снимке на 5 с позже постановки
    } finally {
      for (const n of names) await queue.queue(n).drain(true).catch(() => undefined);
      await queue.close();
    }
  });
});

describe('4.5 и п. 6: пауза для личных аккаунтов (вариант 2)', () => {
  it('по умолчанию пауза 0,3–1 с и «печатает» без ожидания; боты без паузы; прежние значения задаются в .env', async () => {
    const { loadEnv } = await import('../src/config.ts');
    const { testEnv } = await import('./helpers.ts');
    const env = testEnv();
    expect([env.OUTBOUND_PAUSE_MIN_MS, env.OUTBOUND_PAUSE_MAX_MS, env.OUTBOUND_TYPING_MS]).toEqual([300, 1000, 0]);
    const old = testEnv({ OUTBOUND_PAUSE_MIN_MS: '1000', OUTBOUND_PAUSE_MAX_MS: '3000', OUTBOUND_TYPING_MS: '1200' });
    expect([old.OUTBOUND_PAUSE_MIN_MS, old.OUTBOUND_PAUSE_MAX_MS, old.OUTBOUND_TYPING_MS]).toEqual([1000, 3000, 1200]);
    expect(() => loadEnv({ ...process.env, ...Object.fromEntries(Object.entries(testEnv()).map(([k, v]) => [k, String(v)])), OUTBOUND_PAUSE_MIN_MS: '500', OUTBOUND_PAUSE_MAX_MS: '100' })).toThrow(/меньше/);
    // WhatsApp: «печатает» отправлен, но сообщение ушло сразу (typingMs = 0).
    const { RedisPacer } = await import('../src/queue.ts');
    const pacer = new RedisPacer(redis, 300, 1000, () => 0);
    await redis.del(`rfm:pace:424242`);
    for (let i = 0; i < 3; i++) {
      const delay = (await pacer.reserve(424242)) - i * 0; // слоты идут подряд: каждый на 0,3–1 с позже предыдущего
      expect(delay).toBeGreaterThanOrEqual(300 * (i + 1));
      expect(delay).toBeLessThanOrEqual(1000 * (i + 1));
    }
    await t.db.query("UPDATE channels SET kind = 'whatsapp' WHERE id = $1", [t.channel.id]);
    const chat = await clientChat();
    const b = new Bridge({ ...t.bridgeDeps, rest, typingMs: 0 });
    const { messageIds } = await b.queueFromWindow(windowInput(chat.id));
    const started = Date.now();
    await b.deliverToChannel(messageIds[0]!, true, null);
    expect(t.connector.typed).toEqual(['42']);
    expect(t.connector.sent).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('4.9 и 4.10: уведомления, сводка, замеры', () => {
  const channel = (over: Partial<import('../src/store.ts').Channel> = {}) =>
    ({ id: 3, accountId: ACCOUNT, kind: 'vk', title: 'РФ-Двери', externalId: '1', status: 'connected', statusDetail: null, credentials: '', createdAt: new Date(), updatedAt: new Date(), ...over }) as import('../src/store.ts').Channel;

  it('задача ждёт > 30 с и доля ошибок > 20 % — проблемы без 5-минутной задержки; меньше порога — тишина', async () => {
    const chans = [channel()];
    const problems = collectProblems(null, chans, {
      queues: [
        { name: 'rfm-ch-3', waiting: 4, active: 2, delayed: 0, failed: 1, oldestWaitingSec: 45 },
        { name: 'rfm-media', waiting: 1, active: 0, delayed: 0, failed: 0, oldestWaitingSec: 10 },
      ],
      errorRates: [
        { channelId: 3, kind: 'vk', total: 10, sent: 6, failed: 4, queued: 0, p50Ms: 800, p95Ms: 1500 },
        { channelId: 4, kind: 'whatsapp', total: 2, sent: 1, failed: 1, queued: 0, p50Ms: null, p95Ms: null }, // мало сообщений — не считается
      ],
    });
    expect(problems.map((p) => p.key)).toEqual(['queue:rfm-ch-3', 'errors:3']);
    expect(problems[0]).toMatchObject({ title: 'Очередь отправки: Канал «РФ-Двери» (id 3, VK)', afterMs: 0 });
    expect(problems[0]!.detail).toContain('45 с');
    expect(problems[1]!.detail).toContain('4 из 10 (40 %)');
    // Уведомление уходит на первой же проверке.
    const sent: string[] = [];
    const n = new AlertNotifier({ send: async (x) => void sent.push(x), log: silent, now: () => Date.parse('2026-11-17T12:00:00Z') });
    await n.observe(problems);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('Очередь отправки');
  });

  it('сводка за сутки и текст о перезапуске — без номеров и текстов', () => {
    const text = dailySummaryText([{ channelId: 3, kind: 'vk', total: 12, sent: 11, failed: 1, queued: 0, p50Ms: 640, p95Ms: 1900 }], [channel()], new Date('2026-11-17T06:00:00Z'));
    expect(text).toContain('VK «РФ-Двери»: 12 исх., отправлено 11, ошибок 1; медиана 640 мс, 95 % 1.9 с');
    expect(dailySummaryText([], [], new Date())).toContain('исходящих не было');
    expect(restartText('connectors', Date.parse('2026-11-17T06:00:00Z'), Date.parse('2026-11-17T06:05:00Z'))).toMatch(/процесс connectors перезапущен .*5 мин назад/);
    expect(restartText('api', null)).not.toContain('прошлый запуск');
  });

  it('суточная сводка: только в 9 МСК и один раз в день', async () => {
    const day = `rfm:daily:2026-11-17`;
    await redis.del(day);
    expect(await dailySummaryDue(redis, new Date('2026-11-17T05:30:00Z'))).toBe(false); // 08:30 МСК
    expect(await dailySummaryDue(redis, new Date('2026-11-17T06:10:00Z'))).toBe(true); // 09:10 МСК
    expect(await dailySummaryDue(redis, new Date('2026-11-17T06:40:00Z'))).toBe(false);
    await redis.del(day);
  });

  it('outboundStats: всего/отправлено/ошибок и медиана с 95-м процентилем «принято → отправлено» по каналу', async () => {
    const chat = await clientChat();
    const ids: number[] = [];
    for (const ms of [200, 400, 600, 800, 5000]) {
      const { messageIds } = await bridge.queueFromWindow(windowInput(chat.id, `m${ms}`));
      ids.push(messageIds[0]!);
      await t.db.query("UPDATE messages SET status = 'sent', external_id = $2, sent_at = created_at + make_interval(secs => $3) WHERE id = $1", [messageIds[0], `e${ms}`, ms / 1000]);
    }
    const { messageIds: failedIds } = await bridge.queueFromWindow(windowInput(chat.id, 'bad'));
    await t.store.markFailed(failedIds[0]!, 'VK не ответил');
    const [s] = await t.store.outboundStats(Date.now() - 60_000, ACCOUNT);
    expect(s).toMatchObject({ channelId: t.channel.id, kind: 'telegram_bot', total: 6, sent: 5, failed: 1, queued: 0, p50Ms: 600 });
    expect(s!.p95Ms).toBeGreaterThan(4000);
    expect(await t.store.outboundStats(Date.now() - 60_000, 999)).toEqual([]);
  });
});
