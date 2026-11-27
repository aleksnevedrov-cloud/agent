import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Bridge, Logger, StartChatInput } from './bridge.ts';
import { CHANNEL_CONCURRENCY, channelQueueName, START_JOB_TIMEOUT_MS, START_TICKET_TTL_SEC, startTicketKey, type JobData, type StartTicket } from './queue.ts';

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: нет ответа за ${Math.round(ms / 1000)} с — сообщение не отправлено`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Исполнители очередей каналов (п. 4.2): на каждый запущенный канал — свой Worker с небольшим числом
 * одновременных задач. Зависший канал занимает только своих исполнителей; остальные каналы отправляют как обычно.
 */
export class ChannelWorkers {
  private readonly workers = new Map<number, Worker>();

  constructor(
    private readonly o: {
      redis: Redis;
      bridge: Bridge;
      log: Logger;
      concurrency?: number;
      /** Предел на задачу «Написать» целиком (по умолчанию 60 с). */
      startTimeoutMs?: number;
      /** Тесты: своя обработка задачи. */
      process?: (job: Job) => Promise<unknown>;
    },
  ) {}

  ids(): number[] {
    return [...this.workers.keys()];
  }

  /** Сверка с запущенными каналами: новые — исполнитель, удалённые — остановить. */
  async sync(channelIds: readonly number[]): Promise<void> {
    const want = new Set(channelIds);
    for (const id of [...this.workers.keys()]) {
      if (want.has(id)) continue;
      const w = this.workers.get(id);
      this.workers.delete(id);
      await w?.close().catch(() => undefined);
    }
    for (const id of want) {
      if (this.workers.has(id)) continue;
      const w = new Worker(channelQueueName(id), (job) => this.handle(job), {
        connection: this.o.redis.duplicate(),
        concurrency: this.o.concurrency ?? CHANNEL_CONCURRENCY,
      });
      w.on('failed', (job, err) => this.o.log.warn({ job: job?.id, name: job?.name, channelId: id, attempts: job?.attemptsMade, err: err.message }, 'задача канала не выполнена'));
      w.on('error', (err) => this.o.log.warn({ channelId: id, err: err.message }, 'исполнитель канала: ошибка соединения'));
      this.workers.set(id, w);
    }
    // Дожидаемся соединения исполнителей: задачи, поставленные сразу после сверки, не должны ждать.
    await Promise.all([...this.workers.values()].map((w) => w.waitUntilReady().catch(() => undefined)));
  }

  private async handle(job: Job): Promise<unknown> {
    if (this.o.process) return this.o.process(job);
    if (job.name === 'start-chat') return this.startChat(job as Job<StartChatInput>);
    const data = job.data as JobData;
    const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    return this.o.bridge.deliverToChannel(data.messageId, last, data.deadline ?? null);
  }

  /** «Написать первым»: результат — в талон, его читает виджет (п. 4.1). */
  private async startChat(job: Job<StartChatInput>): Promise<void> {
    const key = startTicketKey(String(job.id));
    const accountId = job.data.accountId;
    let result: StartTicket;
    try {
      // Общий предел на всю задачу: даже если какой-то шаг завис в обход своих таймаутов, талон получит ошибку.
      result = { status: 'done', ...(await withTimeout(this.o.bridge.startChat(job.data), this.o.startTimeoutMs ?? START_JOB_TIMEOUT_MS, 'Отправка')) };
    } catch (err) {
      result = { status: 'error', error: (err as Error).message || 'Не удалось отправить' };
      this.o.log.warn({ channelId: job.data.channelId, err: (err as Error).message }, 'написать первым: ошибка');
    }
    await this.o.redis.set(key, JSON.stringify({ ...result, accountId }), 'EX', START_TICKET_TTL_SEC);
  }

  async close(): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => w.close().catch(() => undefined)));
    this.workers.clear();
  }
}

/** Пора ли слать суточную сводку: 09:00 МСК, один раз в день (ключ в Redis на дату). */
export async function dailySummaryDue(redis: Redis, now: Date = new Date()): Promise<boolean> {
  const msk = new Date(now.getTime() + 3 * 3_600_000);
  if (msk.getUTCHours() !== 9) return false;
  const day = msk.toISOString().slice(0, 10);
  return (await redis.set(`rfm:daily:${day}`, '1', 'EX', 2 * 86_400, 'NX')) === 'OK';
}
