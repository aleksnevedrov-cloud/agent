import type { Logger } from './bridge.ts';
import type { ProxyStatus } from './proxy-monitor.ts';
import type { QueueSnapshot } from './queue.ts';
import type { Channel, ChannelStatus, OutboundStat } from './store.ts';

/** Сбой, замеченный при очередной проверке. key — одна и та же проблема между проверками. */
export interface Problem {
  key: string;
  /** Что сломалось: «Канал «…» (id 3, whatsapp)», «Прокси мессенджеров». */
  title: string;
  detail: string;
  /** Через сколько сообщать (мс); по умолчанию — общий порог (5 мин). 0 — сразу (очередь, ошибки отправки). */
  afterMs?: number;
}

/** Очередь считается зависшей, если задача ждёт дольше этого (п. 4.9). */
export const QUEUE_WAIT_ALERT_SEC = 30;
/** Доля ошибок отправки канала за 10 минут, выше которой — уведомление (п. 4.9). */
export const ERROR_RATE_ALERT = 0.2;
export const ERROR_RATE_MIN_MESSAGES = 3;

export interface AlertOptions {
  send(text: string): Promise<void>;
  log: Logger;
  now?: () => number;
  /** Сбой дольше этого — уведомление (по умолчанию 5 мин). */
  afterMs?: number;
  /** Не чаще одного уведомления о сбое по одной проблеме (по умолчанию 30 мин). */
  minIntervalMs?: number;
}

const STATUS_RU: Record<ChannelStatus, string> = {
  starting: 'подключается',
  connected: 'подключён',
  no_phone: 'нет связи',
  session_ended: 'сессия завершена',
  error: 'ошибка',
};

const KIND_RU: Record<string, string> = { telegram_bot: 'Telegram-бот', whatsapp: 'WhatsApp', telegram_user: 'Telegram', max: 'MAX', vk: 'VK', avito: 'Авито', max_phone: 'MAX по номеру' };

/** Каналы, за которыми следим. Telegram личный — тоже, но не на этапе ожидания QR (это ручной шаг). */
const WATCHED = new Set(['telegram_bot', 'whatsapp', 'max', 'vk', 'avito', 'max_phone']);

const fmt = (ms: number) =>
  `${new Date(ms).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} МСК`;
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** Название канала для уведомлений. */
const channelTitle = (c: Pick<Channel, 'id' | 'kind' | 'title'>) => `Канал «${c.title}» (id ${c.id}, ${KIND_RU[c.kind] ?? c.kind})`;

/**
 * Текущие проблемы: прокси не отвечает; канал (кроме ожидающего QR) не в статусе «подключён»;
 * задача ждёт в очереди дольше 30 с; доля ошибок отправки канала за 10 минут выше 20 % (п. 4.9).
 */
export function collectProblems(proxy: ProxyStatus | null, channels: readonly Channel[], extra: { queues?: readonly QueueSnapshot[]; errorRates?: readonly OutboundStat[] } = {}): Problem[] {
  const out: Problem[] = [];
  for (const q of extra.queues ?? []) {
    if (q.oldestWaitingSec < QUEUE_WAIT_ALERT_SEC) continue;
    const ch = /^rfm-ch-(\d+)$/.exec(q.name);
    const c = ch ? channels.find((x) => x.id === Number(ch[1])) : null;
    out.push({
      key: `queue:${q.name}`,
      title: c ? `Очередь отправки: ${channelTitle(c)}` : `Очередь ${q.name}`,
      detail: `Задача ждёт ${q.oldestWaitingSec} с; в очереди ${q.waiting}, выполняется ${q.active}, упало ${q.failed}`,
      afterMs: 0,
    });
  }
  for (const s of extra.errorRates ?? []) {
    const done = s.sent + s.failed;
    if (done < ERROR_RATE_MIN_MESSAGES || s.failed / done <= ERROR_RATE_ALERT) continue;
    const c = channels.find((x) => x.id === s.channelId);
    out.push({
      key: `errors:${s.channelId}`,
      title: c ? `Ошибки отправки: ${channelTitle(c)}` : `Ошибки отправки: канал id ${s.channelId}`,
      detail: `За 10 минут не доставлено ${s.failed} из ${done} (${Math.round((100 * s.failed) / done)} %)`,
      afterMs: 0,
    });
  }
  if (proxy?.status === 'fail') {
    out.push({
      key: 'proxy',
      title: `Прокси мессенджеров (${proxy.active === 'primary' ? 'основной' : 'запасной'})`,
      detail: 'Нет ответа через прокси — Telegram и WhatsApp без связи',
    });
  }
  for (const c of channels) {
    if (!WATCHED.has(c.kind) || c.status === 'connected') continue;
    out.push({
      key: `channel:${c.id}`,
      title: channelTitle(c),
      detail: `Статус: ${STATUS_RU[c.status] ?? c.status}${c.statusDetail ? ` — ${c.statusDetail}` : ''}`,
    });
  }
  return out;
}

/**
 * Уведомления о сбоях: сообщение, если проблема держится дольше 5 мин, и второе — при восстановлении.
 * По одной проблеме — не чаще одного сообщения о сбое в 30 мин. Состояние в памяти процесса connectors.
 */
export class AlertNotifier {
  private readonly open = new Map<string, { since: number; problem: Problem; alerted: boolean }>();
  private readonly lastAlert = new Map<string, number>();

  constructor(private readonly o: AlertOptions) {}

  async observe(problems: readonly Problem[]): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    const afterMs = this.o.afterMs ?? 5 * 60_000;
    const minIntervalMs = this.o.minIntervalMs ?? 30 * 60_000;
    const seen = new Set<string>();

    for (const p of problems) {
      seen.add(p.key);
      const cur = this.open.get(p.key) ?? { since: now, problem: p, alerted: false };
      cur.problem = p;
      this.open.set(p.key, cur);
      if (cur.alerted || now - cur.since < (p.afterMs ?? afterMs)) continue;
      const last = this.lastAlert.get(p.key);
      if (last !== undefined && now - last < minIntervalMs) continue;
      const text = `⚠️ РФ-Мессенджер: ${p.title} не работает с ${fmt(cur.since)} (${minutes(now - cur.since)} мин).\n${p.detail}`;
      if (await this.trySend(text, p.key)) {
        cur.alerted = true;
        this.lastAlert.set(p.key, now);
      }
    }

    for (const [key, cur] of [...this.open]) {
      if (seen.has(key)) continue;
      if (cur.alerted) {
        const text = `✅ РФ-Мессенджер: ${cur.problem.title} снова работает. Сбой с ${fmt(cur.since)} по ${fmt(now)} (${minutes(now - cur.since)} мин).`;
        // Не дошло — попробуем на следующей проверке.
        if (!(await this.trySend(text, key))) continue;
      }
      this.open.delete(key);
    }
  }

  /** Разовое уведомление вне цикла проблем (перезапуск, суточная сводка). */
  notify(text: string): Promise<boolean> {
    return this.trySend(text, 'notify');
  }

  private async trySend(text: string, key: string): Promise<boolean> {
    try {
      await this.o.send(text);
      this.o.log.info({ problem: key }, 'уведомление отправлено');
      return true;
    } catch (err) {
      this.o.log.warn({ problem: key, err: (err as Error).message }, 'уведомление не отправлено');
      return false;
    }
  }
}

/** Текст суточной сводки по каналам (п. 4.10): медиана и 95-й процентиль «принято → отправлено», ошибки. */
export function dailySummaryText(stats: readonly OutboundStat[], channels: readonly Channel[], date: Date = new Date()): string {
  const day = date.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' });
  if (!stats.length) return `📊 РФ-Мессенджер, сводка за ${day}: исходящих не было.`;
  const lines = stats.map((s) => {
    const c = channels.find((x) => x.id === s.channelId);
    const name = c ? `${KIND_RU[c.kind] ?? c.kind} «${c.title}»` : `${KIND_RU[s.kind] ?? s.kind} (id ${s.channelId})`;
    const ms = (v: number | null) => (v === null ? '—' : v < 1000 ? `${v} мс` : `${(v / 1000).toFixed(1)} с`);
    return `• ${name}: ${s.total} исх., отправлено ${s.sent}, ошибок ${s.failed}${s.queued ? `, в очереди ${s.queued}` : ''}; медиана ${ms(s.p50Ms)}, 95 % ${ms(s.p95Ms)}`;
  });
  return `📊 РФ-Мессенджер, сводка за ${day}:\n${lines.join('\n')}`;
}

/** Текст уведомления о перезапуске процесса (п. 4.8, 4.9). */
export function restartText(process: 'api' | 'connectors', previousStartedAt: number | null, now: number = Date.now()): string {
  const since = previousStartedAt ? `; прошлый запуск был ${fmt(previousStartedAt)} (${minutes(now - previousStartedAt)} мин назад)` : '';
  return `🔄 РФ-Мессенджер: процесс ${process} перезапущен ${fmt(now)}${since}. Если это не плановое обновление — проверьте память контейнера (docker stats, OOMKilled).`;
}
