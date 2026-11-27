import type { Redis } from 'ioredis';
import type { Logger } from './bridge.ts';

/**
 * Журнал последних сбоев в Redis (разбор 27.11): предупреждения и ошибки обоих процессов, без телефонов и текстов,
 * чтобы администратор мог открыть «Диагностику» в виджете и переслать её разработчику, не заходя на сервер.
 */
export const RECENT_LOG_KEY = 'rfm:log:recent';
export const RECENT_LOG_LIMIT = 200;
const SKIP_FIELDS = new Set(['text', 'phone', 'name', 'title', 'email', 'token', 'password', 'credentials', 'body', 'payload']);

export interface RecentEntry {
  at: string;
  process: 'api' | 'connectors';
  level: 'warn' | 'error';
  msg: string;
  data: Record<string, unknown>;
}

/** Оставляет только короткие служебные поля (id, коды, тексты ошибок сервисов). */
export function sanitizeEntry(obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SKIP_FIELDS.has(k)) continue;
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.replace(/\+?\d[\d\s()-]{8,}\d/g, (m) => `…${m.replace(/\D/g, '').slice(-4)}`).slice(0, 300);
    else if (v instanceof Error) out[k] = v.message.slice(0, 300);
  }
  return out;
}

export class RecentLog {
  constructor(
    private readonly redis: Redis,
    private readonly process: RecentEntry['process'],
  ) {}

  /** Обёртка над журналом: warn и error дополнительно уходят в Redis; сбой Redis журнал не ломает. */
  wrap(log: Logger): Logger {
    const push = (level: 'warn' | 'error') => (obj: object, msg?: string) => {
      const entry: RecentEntry = { at: new Date().toISOString(), process: this.process, level, msg: msg ?? '', data: sanitizeEntry(obj) };
      void this.redis
        .multi()
        .lpush(RECENT_LOG_KEY, JSON.stringify(entry))
        .ltrim(RECENT_LOG_KEY, 0, RECENT_LOG_LIMIT - 1)
        .exec()
        .catch(() => undefined);
    };
    return {
      info: log.info,
      warn: (obj, msg) => {
        log.warn(obj, msg);
        push('warn')(obj, msg);
      },
      error: (obj, msg) => {
        log.error(obj, msg);
        push('error')(obj, msg);
      },
    };
  }

  static async recent(redis: Redis, limit = 50): Promise<RecentEntry[]> {
    const raw = await redis.lrange(RECENT_LOG_KEY, 0, Math.max(0, limit - 1)).catch(() => []);
    const out: RecentEntry[] = [];
    for (const r of raw) {
      try {
        out.push(JSON.parse(r) as RecentEntry);
      } catch {
        /* мусор пропускаем */
      }
    }
    return out;
  }
}
