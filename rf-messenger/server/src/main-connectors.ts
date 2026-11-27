import { setDefaultResultOrder } from 'node:dns';
import { Worker } from 'bullmq';
import { CHANNELS_CHANGED, qrKey, tgPasswordKey } from './api/app.ts';
import { TelegramUserConnector } from './connectors/telegram-user.ts';
import { Bridge, type Logger } from './bridge.ts';
import { loadEnv } from './config.ts';
import { ConnectorHost, greenApiWebhookUrl, makeFactory } from './connectors/host.ts';
import { MaxGreenApiConnector } from './connectors/max-greenapi.ts';
import type { AvitoConnector } from './connectors/avito.ts';
import { AlertNotifier, collectProblems, dailySummaryText, restartText } from './alerts.ts';
import { TelegramBotApi, TelegramBotConnector } from './connectors/telegram-bot.ts';
import { WhatsAppConnector } from './connectors/whatsapp.ts';
import { migrate } from './db.ts';
import { createMessengerProxy, proxySecrets, ProxySwitch, redactSecrets } from './proxy.ts';
import { httpProbe, PROXY_CHECK_INTERVAL_MS, ProxyMonitor } from './proxy-monitor.ts';
import { createCore } from './deps.ts';
import { BullJobQueue, channelQueueName, MEDIA_CONCURRENCY, MEDIA_QUEUE_NAME, QUEUE_NAME, RedisPacer, START_QUEUE_NAME, WEBHOOK_QUEUE_NAME, type JobData, type JobName, type WebhookJob } from './queue.ts';
import type { StartChatInput, WindowSendInput } from './bridge.ts';
import { ChannelWorkers, dailySummaryDue } from './workers.ts';
import { RecentLog } from './recent-log.ts';
import { RedisChatEvents } from './events.ts';

// На сервере нет рабочего IPv6: без этого запросы к Telegram/WhatsApp периодически зависают на AAAA-адресах.
setDefaultResultOrder('ipv4first');

/**
 * Процесс connectors: держит сессии каналов, принимает входящие, выполняет очередь отправки.
 * Отдельный от api процесс: зависание коннектора не роняет вебхук amo и наоборот.
 */
const env = loadEnv();
const core = createCore(env);
await migrate(core.db);

// Логин и пароль прокси не должны попасть в журнал, даже внутри текста ошибки.
// Токен бота уведомлений — туда же.
const secrets = [...proxySecrets(env.MESSENGER_PROXY_URL), ...proxySecrets(env.MESSENGER_PROXY_URL_FALLBACK), ...(env.ALERT_TG_BOT_TOKEN ? [env.ALERT_TG_BOT_TOKEN] : [])].sort(
  (a, b) => b.length - a.length,
);
const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
const write = (level: string) => (obj: object, msg?: string) => {
  if (levels.indexOf(level) <= levels.indexOf(env.LOG_LEVEL)) process.stdout.write(`${redactSecrets(JSON.stringify({ level, time: new Date().toISOString(), msg, ...obj }), secrets)}\n`);
};
const log: Logger = new RecentLog(core.redis, 'connectors').wrap({ info: write('info'), warn: write('warn'), error: write('error') });

// Прокси только для Telegram и WhatsApp; amoCRM (amojo, вложения), postgres, redis — напрямую.
// Основной и запасной; Telegram берёт текущий при каждом запросе, WhatsApp — при подключении.
const proxies = new ProxySwitch(createMessengerProxy(env.MESSENGER_PROXY_URL), createMessengerProxy(env.MESSENGER_PROXY_URL_FALLBACK));
const dispatcher = () => proxies.current()?.dispatcher;
const waProxy = () => proxies.current() ?? undefined;
// Адрес прокси в журнал не пишем — только задан ли он.
log.info({ proxy: proxies.primary ? 'задан' : 'нет', fallback: proxies.fallback ? 'задан' : 'нет', alerts: env.ALERT_TG_BOT_TOKEN ? 'включены' : 'нет' }, 'исходящий прокси мессенджеров');

// Очереди по каналам (to-channel, start-chat), rfm-media (вложения, история), rfm-messages (в amo).
const queue = new BullJobQueue(core.redis);
// eslint-disable-next-line prefer-const -- host и bridge ссылаются друг на друга
let host: ConnectorHost;
const bridge = new Bridge({
  store: core.store,
  files: core.files,
  amojo: core.amojo,
  queue,
  pacer: new RedisPacer(core.redis, env.OUTBOUND_PAUSE_MIN_MS, env.OUTBOUND_PAUSE_MAX_MS),
  connector: (id) => host.get(id),
  amoDomains: env.AMO_ALLOWED_DOMAINS,
  log,
  typingMs: env.OUTBOUND_TYPING_MS,
  rest: core.rest,
  events: new RedisChatEvents(core.redis),
  maxIdField: env.MAX_ID_FIELD,
});
const waQrKey = (id: number) => qrKey('whatsapp', id);
const sessionOf = (id: number) => ({
  load: async () => {
    const sealed = await core.store.getChannelSession(id);
    return sealed ? core.box.decrypt(sealed) : null;
  },
  save: (s: string) => core.store.setChannelSession(id, core.box.encrypt(s)),
  clear: () => core.store.setChannelSession(id, null),
});
/** Пароль 2FA Telegram из виджета: ждём до 5 минут, забираем один раз. */
const waitTgPassword = async (id: number): Promise<string | null> => {
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    const sealed = await core.redis.getdel(tgPasswordKey(id));
    if (sealed) return core.box.decrypt(sealed);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
};
const baseFactory = makeFactory({ publicUrl: env.PUBLIC_URL, log: (channelId, level, msg) => log[level]({ channelId }, msg) });
host = new ConnectorHost(core.store, core.box, () => bridge, log, (channel, creds) => {
  if (channel.kind === 'whatsapp') {
    return new WhatsAppConnector({
      session: {
        load: async () => {
          const sealed = await core.store.getChannelSession(channel.id);
          return sealed ? core.box.decrypt(sealed) : null;
        },
        save: (json) => core.store.setChannelSession(channel.id, core.box.encrypt(json)),
        clear: () => core.store.setChannelSession(channel.id, null),
      },
      onQr: async (qr) => void (qr ? await core.redis.set(waQrKey(channel.id), qr, 'EX', 70) : await core.redis.del(waQrKey(channel.id))),
      onIdentity: (phone) => core.store.setChannelIdentity(channel.id, phone, `WhatsApp ${phone}`),
      log: (level, msg) => log[level]({ channelId: channel.id }, msg),
      ...(proxies.primary ? { proxy: waProxy } : {}),
    });
  }
  if (channel.kind === 'telegram_user') {
    if (!env.TELEGRAM_API_ID) return null;
    const key = qrKey('telegram_user', channel.id);
    return new TelegramUserConnector({
      apiId: env.TELEGRAM_API_ID,
      apiHash: env.TELEGRAM_API_HASH,
      session: sessionOf(channel.id),
      onQr: async (url) => void (url ? await core.redis.set(key, url, 'EX', 70) : await core.redis.del(key)),
      password: () => waitTgPassword(channel.id),
      onIdentity: (phone) => core.store.setChannelIdentity(channel.id, phone, `Telegram ${phone}`),
      log: (level, msg) => log[level]({ channelId: channel.id }, msg),
    });
  }
  if (channel.kind === 'max_phone' && creds.idInstance && creds.apiTokenInstance) {
    const key = qrKey('max_phone', channel.id);
    return new MaxGreenApiConnector(
      { idInstance: creds.idInstance, apiTokenInstance: creds.apiTokenInstance, ...(creds.apiUrl ? { apiUrl: creds.apiUrl } : {}), ...(creds.mediaUrl ? { mediaUrl: creds.mediaUrl } : {}) },
      {
        onQr: async (dataUrl) => void (dataUrl ? await core.redis.set(key, dataUrl, 'EX', 70) : await core.redis.del(key)),
        onIdentity: (phone) => core.store.setChannelIdentity(channel.id, phone, `MAX ${phone}`),
        ...(creds.webhookSecret ? { webhookUrl: greenApiWebhookUrl(env.PUBLIC_URL, channel.id), webhookToken: creds.webhookSecret } : {}),
        log: (level, msg) => log[level]({ channelId: channel.id }, msg),
      },
    );
  }
  if (channel.kind === 'telegram_bot' && creds.token) {
    return new TelegramBotConnector(creds.token, {
      ...(proxies.primary ? { dispatcher } : {}),
      onError: (err) => log.warn({ channelId: channel.id, err: (err as Error).message }, 'telegram: ошибка опроса'),
    });
  }
  // MAX, VK, Авито — российские сервисы, идут напрямую, без прокси.
  return baseFactory(channel, creds);
});

// Передача в amoCRM: быстрые задачи (текст, статус). Задачи старого формата (to-channel, history, media в общей
// очереди) дорабатываются здесь же — на время обновления.
const worker = new Worker<JobData, void, JobName>(
  QUEUE_NAME,
  async (job) => {
    const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (job.name === 'to-amo') return bridge.deliverToAmo(job.data.messageId);
    if (job.name === 'to-amo-media') return bridge.deliverMediaToAmo(job.data.messageId);
    if (job.name === 'history') return void (await bridge.importHistory(job.data.chatId ?? 0));
    if (job.name === 'media') return bridge.fetchInboundMedia(job.data, last);
    return bridge.deliverToChannel(job.data.messageId, last, job.data.deadline ?? null);
  },
  { connection: core.redis.duplicate(), concurrency: 4 },
);
worker.on('failed', (job, err) => log.warn({ job: job?.id, name: job?.name, attempts: job?.attemptsMade, err: err.message }, 'задача не выполнена'));
// Тяжёлые задачи отдельно (п. 4.6): скачивание вложений и импорт истории не занимают исполнителей текста.
const mediaWorker = new Worker<JobData, void, JobName>(
  MEDIA_QUEUE_NAME,
  async (job) => {
    const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (job.name === 'history') return void (await bridge.importHistory(job.data.chatId ?? 0));
    return bridge.fetchInboundMedia(job.data, last);
  },
  { connection: core.redis.duplicate(), concurrency: MEDIA_CONCURRENCY },
);
mediaWorker.on('failed', (job, err) => log.warn({ job: job?.id, name: job?.name, attempts: job?.attemptsMade, err: err.message }, 'тяжёлая задача не выполнена'));
// Исходящие в каналы: у каждого канала своя очередь и свои исполнители (п. 4.2).
const channelWorkers = new ChannelWorkers({ redis: core.redis, bridge, log });
// Задачи старого формата из очереди «Написать первым» (api прежней версии, если успел поставить).
const startWorker = new Worker<StartChatInput | WindowSendInput, unknown>(
  START_QUEUE_NAME,
  (job) => (job.name === 'window-send' ? bridge.queueFromWindow(job.data as WindowSendInput) : bridge.startChat(job.data as StartChatInput)),
  { connection: core.redis.duplicate(), concurrency: 1 },
);
startWorker.on('failed', (job, err) => log.warn({ job: job?.id, name: job?.name, err: err.message }, 'отправка из карточки: не выполнено'));
// Вебхуки Авито: api проверил секрет и положил тело в очередь; разбирает коннектор канала.
const webhookWorker = new Worker<WebhookJob>(
  WEBHOOK_QUEUE_NAME,
  async (job) => {
    // Авито и GREEN-API (MAX по номеру): у обоих коннекторов есть onWebhook.
    const c = host.get(job.data.channelId) as (AvitoConnector & { onWebhook?: (b: unknown) => Promise<void> }) | undefined;
    if (!c?.onWebhook) throw new Error('Коннектор канала не запущен');
    await c.onWebhook(job.data.body);
  },
  { connection: core.redis.duplicate(), concurrency: 2 },
);
webhookWorker.on('failed', (job, err) => log.warn({ job: job?.id, channelId: job?.data.channelId, err: err.message }, 'вебхук не обработан'));

// Сверка каналов и их очередей: исполнители есть у всех активных каналов, даже если коннектор пока не поднялся
// (тогда задача упадёт с понятной ошибкой «канал не запущен», а не повиснет в очереди).
const syncAll = async () => {
  await host.syncAll();
  await channelWorkers.sync((await core.store.activeChannels()).map((c) => c.id));
};
await syncAll();
const sub = core.redis.duplicate();
await sub.subscribe(CHANNELS_CHANGED);
sub.on('message', (_ch, payload: string) => {
  const restart = /^restart:(\d+)$/.exec(payload);
  const job = restart ? host.restart(Number(restart[1])) : syncAll();
  void job.catch((err: Error) => log.error({ err: err.message }, 'сверка каналов'));
});
// Подстраховка, если сообщение pub/sub потерялось.
const timer = setInterval(() => void syncAll().catch(() => undefined), 60_000);

// Смена прокси: Telegram подхватит сам, WhatsApp переподключаем с той же сессией.
proxies.onChange(() => void host.restartKind('whatsapp').catch((err: Error) => log.error({ err: err.message }, 'переподключение WhatsApp после смены прокси')));

// Проверка прокси раз в минуту и уведомления о сбоях прокси и каналов.
const monitor = new ProxyMonitor({ sw: proxies, probe: httpProbe(), redis: core.redis, log });
const alertApi = env.ALERT_TG_BOT_TOKEN ? new TelegramBotApi(env.ALERT_TG_BOT_TOKEN, { dispatcher, retry: { retries: 2 } }) : null;
const alerts = alertApi
  ? new AlertNotifier({ send: async (text) => void (await alertApi.call('sendMessage', { chat_id: env.ALERT_TG_CHAT_ID, text }, 15_000)), log })
  : null;
// Перезапуск процессов — уведомление сразу (п. 4.8): своё — по прошлому времени запуска, api — по его метке.
const bootNow = Date.now();
const prevBoot = Number(await core.redis.getset('rfm:boot:connectors', String(bootNow)).catch(() => null)) || null;
if (alerts && prevBoot) await alerts.notify(restartText('connectors', prevBoot, bootNow)).catch(() => undefined);
let apiBootSeen = await core.redis.get('rfm:boot:api').catch(() => null);
const healthTick = async () => {
  const status = await monitor.tick();
  const channels = await core.store.activeChannels();
  // Очереди и ошибки отправки — часть проверки (п. 4.9): задача ждёт > 30 с, ошибок > 20 % за 10 минут.
  const queues = await queue.snapshot([QUEUE_NAME, MEDIA_QUEUE_NAME, ...channels.map((c) => channelQueueName(c.id))]).catch(() => []);
  const errorRates = await core.store.outboundStats(Date.now() - 10 * 60_000).catch(() => []);
  if (alerts) await alerts.observe(collectProblems(status, channels, { queues, errorRates }));
  const apiBoot = await core.redis.get('rfm:boot:api').catch(() => null);
  if (alerts && apiBoot && apiBootSeen && apiBoot !== apiBootSeen) await alerts.notify(restartText('api', Number(apiBootSeen) || null, Number(apiBoot) || Date.now())).catch(() => undefined);
  apiBootSeen = apiBoot ?? apiBootSeen;
  // Суточная сводка (п. 4.10): 09:00 МСК.
  if (alerts && (await dailySummaryDue(core.redis))) await alerts.notify(dailySummaryText(await core.store.outboundStats(Date.now() - 86_400_000), channels)).catch(() => undefined);
};
void healthTick().catch((err: Error) => log.error({ err: err.message }, 'проверка прокси'));
const healthTimer = setInterval(() => void healthTick().catch((err: Error) => log.error({ err: err.message }, 'проверка прокси')), PROXY_CHECK_INTERVAL_MS);
// Входящие, оставшиеся без передачи в amo (сбой или перезапуск между сохранением и очередью), — заново в очередь.
const requeue = () => void bridge.requeueStuckInbound().catch((err: Error) => log.error({ err: err.message }, 'повтор зависших входящих'));
requeue();
const requeueTimer = setInterval(requeue, 5 * 60_000);
log.info({}, 'connectors запущен');

const shutdown = async () => {
  clearInterval(timer);
  clearInterval(healthTimer);
  clearInterval(requeueTimer);
  await worker.close();
  await mediaWorker.close();
  await channelWorkers.close();
  await startWorker.close();
  await webhookWorker.close();
  await host.stopAll();
  await queue.close();
  await sub.quit();
  await core.redis.quit();
  await core.db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
