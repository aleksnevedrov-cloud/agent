import { setDefaultResultOrder } from 'node:dns';
import { Queue } from 'bullmq';
import { buildApp } from './api/app.ts';
import { Bridge } from './bridge.ts';
import { loadEnv } from './config.ts';
import { migrate } from './db.ts';
import { createCore } from './deps.ts';
import { chatEventsChannel, parseChatEvent, RedisChatEvents, type ChatEvent } from './events.ts';
import { BullJobQueue, channelQueueName, MEDIA_QUEUE_NAME, QUEUE_NAME, RedisPacer, WEBHOOK_JOB_OPTIONS, WEBHOOK_QUEUE_NAME, type WebhookJob } from './queue.ts';

// На сервере нет рабочего IPv6: без этого запросы к Telegram/WhatsApp периодически зависают на AAAA-адресах.
setDefaultResultOrder('ipv4first');

/** Процесс api: вебхук amo, API виджета, раздача файлов. Сообщения в каналы отправляет процесс connectors. */
const env = loadEnv();
const core = createCore(env);
await migrate(core.db);
// Очереди по каналам (to-channel, start-chat), rfm-media (вложения, история), rfm-messages (в amo).
const queue = new BullJobQueue(core.redis);
const bridge = new Bridge({
  store: core.store,
  files: core.files,
  amojo: core.amojo,
  queue,
  pacer: new RedisPacer(core.redis, env.OUTBOUND_PAUSE_MIN_MS, env.OUTBOUND_PAUSE_MAX_MS),
  connector: () => undefined,
  amoDomains: env.AMO_ALLOWED_DOMAINS,
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  rest: core.rest,
  events: new RedisChatEvents(core.redis),
  maxIdField: env.MAX_ID_FIELD,
});
// Время запуска — для уведомления о перезапуске (его шлёт процесс connectors).
await core.redis.set('rfm:boot:api', String(Date.now())).catch(() => undefined);
const webhookQueue = new Queue<WebhookJob>(WEBHOOK_QUEUE_NAME, { connection: core.redis, defaultJobOptions: WEBHOOK_JOB_OPTIONS });

// События окна переписки: один подписчик Redis на процесс, раздача открытым SSE-соединениям по аккаунту.
const eventSub = core.redis.duplicate();
const listeners = new Map<number, Set<(ev: ChatEvent) => void>>();
await eventSub.psubscribe(chatEventsChannel(0).replace(/0$/, '*'));
eventSub.on('pmessage', (_p, channel: string, raw: string) => {
  const accountId = Number(channel.split(':').pop());
  const ev = parseChatEvent(raw);
  if (!ev) return;
  for (const fn of listeners.get(accountId) ?? []) fn(ev);
});

const app = await buildApp({
  ...core,
  env,
  bridge,
  queue,
  webhooks: { add: async (channelId, body) => void (await webhookQueue.add('avito', { channelId, body })) },
  // «Написать» и отправка из окна не ждут коннектор: задача в очередь канала, ответ сразу (п. 4.1).
  startChat: async (input) => ({ ticket: await queue.addStart(input) }),
  windowSend: (input) => bridge.queueFromWindow(input),
  queueSnapshot: async () => {
    const channels = await core.store.activeChannels();
    return queue.snapshot([QUEUE_NAME, MEDIA_QUEUE_NAME, ...channels.map((c) => channelQueueName(c.id))]);
  },
  events: {
    subscribe: (accountId, fn) => {
      const set = listeners.get(accountId) ?? new Set();
      set.add(fn);
      listeners.set(accountId, set);
      return () => {
        set.delete(fn);
        if (!set.size) listeners.delete(accountId);
      };
    },
  },
});
await app.listen({ host: env.HOST, port: env.PORT });

const shutdown = async () => {
  await app.close();
  await queue.close();
  await webhookQueue.close();
  await eventSub.quit();
  await core.redis.quit();
  await core.db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
