import { Queue, type Job, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { InboundAttachment } from './connectors/types.ts';

/**
 * Очереди (ТЗ от 17.11, п. 4.1–4.3, 4.6, 4.7):
 * - rfm-ch-<id> — исходящие в один канал (to-channel, start-chat): у каждого канала свои исполнители,
 *   зависший канал не задерживает остальные;
 * - rfm-media — тяжёлые задачи: скачивание вложений, импорт истории;
 * - rfm-messages — передача в amoCRM (to-amo, to-amo-media) и задачи старого формата после обновления.
 */
export type JobName = 'to-amo' | 'to-amo-media' | 'to-channel' | 'history' | 'media';
export interface JobData {
  /** to-amo, to-channel, media — id сообщения; history — 0. */
  messageId: number;
  /** history: загрузка истории чата из мессенджера. */
  chatId?: number;
  /** to-channel, media: канал — определяет очередь. */
  channelId?: number;
  /** to-channel: срок (unix мс), после которого сообщение помечается недоставленным (п. 4.7). */
  deadline?: number;
  /** media: что скачивать (ссылка внутри канала). */
  attachment?: InboundAttachment;
}

export interface JobQueue {
  add(name: JobName, data: JobData, opts: { jobId: string; delay?: number }): Promise<void>;
}

export const QUEUE_NAME = 'rfm-messages';
export const MEDIA_QUEUE_NAME = 'rfm-media';
export const channelQueueName = (channelId: number) => `rfm-ch-${channelId}`;
export const isChannelQueue = (name: string) => /^rfm-ch-\d+$/.test(name);

/** Передача в amoCRM: повторы долгие — amo может быть недоступен, но сообщение терять нельзя. */
export const JOB_OPTIONS = {
  attempts: 10,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 10_000 },
  removeOnFail: { age: 7 * 86_400 },
} as const;

/** Один запрос к мессенджеру при отправке (п. 4.3). */
export const SEND_REQUEST_TIMEOUT_MS = 10_000;
/** Вся отправка одного сообщения, включая повтор внутри коннектора (п. 4.3). */
export const SEND_TIMEOUT_MS = 20_000;
/** Срок жизни исходящего в очереди: дольше — «ошибка» с причиной и кнопка «Повторить» (п. 4.7). */
export const SEND_DEADLINE_MS = 120_000;
/** Исходящие в канал: 3 попытки с паузой 15 с — укладываются в 2 минуты вместе с таймаутами. */
export const TO_CHANNEL_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'fixed', delay: 15_000 },
  removeOnComplete: { age: 86_400, count: 10_000 },
  removeOnFail: { age: 7 * 86_400 },
} as const;
/** Вложения и история: 2 попытки, затем сообщение уходит в amo без файла. */
export const MEDIA_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'fixed', delay: 10_000 },
  removeOnComplete: { age: 86_400, count: 5_000 },
  removeOnFail: { age: 7 * 86_400 },
} as const;
/** Сколько исполнителей на канал и на тяжёлые задачи. */
export const CHANNEL_CONCURRENCY = 2;
export const MEDIA_CONCURRENCY = 2;

/** «Написать первым»: задача в очереди канала, без повторов (повтор отправил бы клиенту дубль). Результат — по талону. */
export const START_QUEUE_NAME = 'rfm-start-chat';
export const START_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 86_400 },
} as const;
/** Сколько api ждёт выполнения задач старого формата (совместимость на время обновления). */
export const START_WAIT_MS = 60_000;
export const startTicketKey = (ticket: string) => `rfm:start:${ticket}`;
export const START_TICKET_TTL_SEC = 600;
export type StartTicket = { status: 'pending' } | { status: 'done'; chatId: number; messageId: number } | { status: 'error'; error: string };

/** Вебхуки мессенджеров (Авито, GREEN-API): api принимает и ставит в очередь, connectors разбирает коннектором канала. */
export const WEBHOOK_QUEUE_NAME = 'rfm-webhooks';
export const WEBHOOK_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 3_000 },
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 86_400 },
} as const;
export interface WebhookJob {
  channelId: number;
  body: unknown;
}

/** Состояние очереди для /health и уведомлений. */
export interface QueueSnapshot {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  /** Сколько секунд ждёт самая старая задача в очереди (без учёта отложенных). */
  oldestWaitingSec: number;
}

/**
 * Очереди BullMQ с маршрутизацией по имени задачи: to-channel и start-chat — в очередь канала,
 * media и history — в rfm-media, остальное — в rfm-messages. Один экземпляр на процесс.
 */
export class BullJobQueue implements JobQueue {
  private readonly queues = new Map<string, Queue>();

  constructor(
    private readonly redis: Redis,
    private readonly now: () => number = Date.now,
  ) {}

  queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      const defaultJobOptions: JobsOptions = name === MEDIA_QUEUE_NAME ? MEDIA_JOB_OPTIONS : isChannelQueue(name) ? TO_CHANNEL_JOB_OPTIONS : JOB_OPTIONS;
      q = new Queue(name, { connection: this.redis, defaultJobOptions });
      this.queues.set(name, q);
    }
    return q;
  }

  /** Очередь для задачи: канал известен — его очередь, иначе общая (задачи старого формата). */
  queueFor(name: JobName, data: JobData): Queue {
    if (name === 'to-channel' && data.channelId) return this.queue(channelQueueName(data.channelId));
    if (name === 'media' || name === 'history') return this.queue(MEDIA_QUEUE_NAME);
    return this.queue(QUEUE_NAME);
  }

  async add(name: JobName, data: JobData, opts: { jobId: string; delay?: number }): Promise<void> {
    const q = this.queueFor(name, data);
    const jobOpts: JobsOptions = { jobId: opts.jobId, ...(opts.delay ? { delay: opts.delay } : {}) };
    await q.add(name, data, jobOpts);
  }

  /** «Написать первым»: задача в очереди канала; талон — id задачи. */
  async addStart<T extends { channelId: number }>(input: T): Promise<string> {
    const job = await this.queue(channelQueueName(input.channelId)).add('start-chat', input, { ...START_JOB_OPTIONS });
    return String(job.id);
  }

  async snapshot(names: readonly string[]): Promise<QueueSnapshot[]> {
    const out: QueueSnapshot[] = [];
    for (const name of names) {
      const q = this.queue(name);
      const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'prioritized');
      const oldest = (await q.getWaiting(0, 0))[0] as Job | undefined;
      out.push({
        name,
        waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        oldestWaitingSec: oldest ? Math.max(0, Math.round((this.now() - oldest.timestamp) / 1000)) : 0,
      });
    }
    return out;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}

/** Распределение исходящих по времени: в один чат не чаще, чем раз в min–max мс (раздел 6 ТЗ). */
export interface Pacer {
  /** Резервирует слот отправки в чат; возвращает задержку в мс до слота. */
  reserve(chatId: number): Promise<number>;
}

// Атомарно: слот = max(сейчас, предыдущий слот + пауза). Слоты одного чата идут по возрастанию — порядок сохраняется.
const RESERVE_LUA = `
local prev = tonumber(redis.call('GET', KEYS[1]) or '0')
local slot = math.max(tonumber(ARGV[1]), prev + tonumber(ARGV[2]))
redis.call('SET', KEYS[1], slot, 'PX', 600000)
return slot
`;

export class RedisPacer implements Pacer {
  constructor(
    private readonly redis: Redis,
    private readonly minMs: number,
    private readonly maxMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async reserve(chatId: number): Promise<number> {
    const pause = this.minMs + Math.floor(Math.random() * (this.maxMs - this.minMs + 1));
    const now = this.now();
    const slot = Number(await this.redis.eval(RESERVE_LUA, 1, `rfm:pace:${chatId}`, String(now), String(pause)));
    return Math.max(0, slot - now);
  }
}
