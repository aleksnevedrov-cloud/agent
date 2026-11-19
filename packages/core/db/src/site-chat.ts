import { randomBytes } from 'node:crypto';
import type { Db } from './pool.ts';

/**
 * RFD-SITE-CHAT-AGENT: сессии и сообщения чата на сайте.
 * Сессия создаётся формой (имя, телефон, почта, согласие), заявка в amoCRM — на первом сообщении,
 * запись в amoCRM идёт очередью воркера (поля amo_*), агент отвечает независимо от неё.
 */
export type SiteChatState = 'active' | 'handed_off' | 'closed' | 'spam';
export type SiteChatAuthor = 'client' | 'agent' | 'system';
export type SiteSync = 'pending' | 'sent' | 'failed';

export interface SiteChatSession {
  id: string;
  accountId: number;
  createdAt: Date;
  lastSeenAt: Date;
  name: string;
  phone: string;
  email: string;
  consentAt: Date;
  pageUrl: string | null;
  pageTitle: string | null;
  referrer: string | null;
  utm: Record<string, string>;
  ymUid: string | null;
  gaCid: string | null;
  ip: string | null;
  userAgent: string | null;
  state: SiteChatState;
  handoffReason: string | null;
  amoUnsortedUid: string | null;
  amoLeadId: number | null;
  amoContactId: number | null;
  amoSync: SiteSync;
  amoAttempts: number;
  amoNextTryAt: Date;
  amoError: string | null;
  summaryText: string | null;
  summarySync: 'none' | 'pending' | 'sent';
  summaryNoteId: number | null;
  taskSync: 'none' | 'pending' | 'sent';
  taskId: number | null;
  closedAt: Date | null;
}

export interface SiteChatProduct {
  id: string;
  name: string;
  price: number | null;
  url: string | null;
  picture: string | null;
}

export interface SiteChatMessage {
  id: number;
  sessionId: string;
  createdAt: Date;
  author: SiteChatAuthor;
  text: string;
  products: SiteChatProduct[];
  costRub: number;
  amoNoteId: number | null;
  amoSync: SiteSync | 'skipped';
}

export interface NewSiteSession {
  accountId: number;
  name: string;
  phone: string;
  email: string;
  consentAt: Date;
  pageUrl?: string | null;
  pageTitle?: string | null;
  referrer?: string | null;
  utm?: Record<string, string>;
  ymUid?: string | null;
  gaCid?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  state?: SiteChatState;
}

/** Телефон → 7XXXXXXXXXX; null — не российский номер из 11 цифр (8 → 7). */
export function normalizeRuPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10 && !digits.startsWith('7')) return `7${digits}`;
  if (digits.length !== 11) return null;
  if (digits.startsWith('8')) return `7${digits.slice(1)}`;
  if (digits.startsWith('7')) return digits;
  return null;
}

/** Последние 10 цифр — ключ совпадения контактов amoCRM. */
export const phoneKey = (raw: string): string => raw.replace(/\D/g, '').slice(-10);

/** Пауза перед повтором записи в amoCRM: 1, 5, 15, 60 минут; после 4 неудач — failed. */
export const SITE_SYNC_BACKOFF_MIN = [1, 5, 15, 60] as const;
export const SITE_SYNC_MAX_ATTEMPTS = SITE_SYNC_BACKOFF_MIN.length;

function session(r: Record<string, unknown>): SiteChatSession {
  return {
    id: String(r.id),
    accountId: Number(r.account_id),
    createdAt: r.created_at as Date,
    lastSeenAt: r.last_seen_at as Date,
    name: String(r.name),
    phone: String(r.phone),
    email: String(r.email),
    consentAt: r.consent_at as Date,
    pageUrl: (r.page_url as string | null) ?? null,
    pageTitle: (r.page_title as string | null) ?? null,
    referrer: (r.referrer as string | null) ?? null,
    utm: (r.utm as Record<string, string> | null) ?? {},
    ymUid: (r.ym_uid as string | null) ?? null,
    gaCid: (r.ga_cid as string | null) ?? null,
    ip: (r.ip as string | null) ?? null,
    userAgent: (r.user_agent as string | null) ?? null,
    state: r.state as SiteChatState,
    handoffReason: (r.handoff_reason as string | null) ?? null,
    amoUnsortedUid: (r.amo_unsorted_uid as string | null) ?? null,
    amoLeadId: r.amo_lead_id === null || r.amo_lead_id === undefined ? null : Number(r.amo_lead_id),
    amoContactId: r.amo_contact_id === null || r.amo_contact_id === undefined ? null : Number(r.amo_contact_id),
    amoSync: r.amo_sync as SiteSync,
    amoAttempts: Number(r.amo_attempts),
    amoNextTryAt: r.amo_next_try_at as Date,
    amoError: (r.amo_error as string | null) ?? null,
    summaryText: (r.summary_text as string | null) ?? null,
    summarySync: r.summary_sync as SiteChatSession['summarySync'],
    summaryNoteId: r.summary_note_id === null || r.summary_note_id === undefined ? null : Number(r.summary_note_id),
    taskSync: r.task_sync as SiteChatSession['taskSync'],
    taskId: r.task_id === null || r.task_id === undefined ? null : Number(r.task_id),
    closedAt: (r.closed_at as Date | null) ?? null,
  };
}

function message(r: Record<string, unknown>): SiteChatMessage {
  return {
    id: Number(r.id),
    sessionId: String(r.session_id),
    createdAt: r.created_at as Date,
    author: r.author as SiteChatAuthor,
    text: String(r.text),
    products: (r.products as SiteChatProduct[] | null) ?? [],
    costRub: Number(r.cost_rub),
    amoNoteId: r.amo_note_id === null || r.amo_note_id === undefined ? null : Number(r.amo_note_id),
    amoSync: r.amo_sync as SiteChatMessage['amoSync'],
  };
}

export class SiteChatRepo {
  constructor(private readonly db: Db) {}

  async create(s: NewSiteSession): Promise<SiteChatSession> {
    const id = randomBytes(16).toString('hex');
    const state = s.state ?? 'active';
    const { rows } = await this.db.query(
      `INSERT INTO site_chat_sessions
         (id, account_id, name, phone, email, consent_at, page_url, page_title, referrer, utm, ym_uid, ga_cid, ip, user_agent, state, amo_sync)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        id,
        s.accountId,
        s.name,
        s.phone,
        s.email,
        s.consentAt,
        s.pageUrl ?? null,
        s.pageTitle ?? null,
        s.referrer ?? null,
        s.utm ?? {},
        s.ymUid ?? null,
        s.gaCid ?? null,
        s.ip ?? null,
        s.userAgent ?? null,
        state,
        // Спам в amoCRM не идёт.
        state === 'spam' ? 'failed' : 'pending',
      ],
    );
    return session(rows[0] as Record<string, unknown>);
  }

  async get(id: string): Promise<SiteChatSession | null> {
    const { rows } = await this.db.query('SELECT * FROM site_chat_sessions WHERE id = $1', [id]);
    return rows[0] ? session(rows[0] as Record<string, unknown>) : null;
  }

  async touch(id: string, at: Date = new Date()): Promise<void> {
    await this.db.query('UPDATE site_chat_sessions SET last_seen_at = $2 WHERE id = $1', [id, at]);
  }

  /** Сколько сессий (не спама) создано с этого IP за окно — лимиты 3 за 10 минут и 20 за сутки. */
  async countByIp(ip: string, sinceMs: number, now: Date = new Date()): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM site_chat_sessions WHERE ip = $1 AND created_at > $2`,
      [ip, new Date(now.getTime() - sinceMs)],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Тот же телефон и тот же первый текст за окно — повтор формы, вторая заявка не создаётся. */
  async findDuplicate(accountId: number, phone: string, text: string, sinceMs: number, now: Date = new Date()): Promise<SiteChatSession | null> {
    const { rows } = await this.db.query(
      `SELECT s.* FROM site_chat_sessions s
        WHERE s.account_id = $1 AND s.phone = $2 AND s.created_at > $3 AND s.state <> 'spam'
          AND EXISTS (SELECT 1 FROM site_chat_messages m WHERE m.session_id = s.id AND m.author = 'client' AND m.text = $4)
        ORDER BY s.created_at DESC LIMIT 1`,
      [accountId, phone, new Date(now.getTime() - sinceMs), text],
    );
    return rows[0] ? session(rows[0] as Record<string, unknown>) : null;
  }

  async addMessage(
    sessionId: string,
    author: SiteChatAuthor,
    text: string,
    opts: { products?: SiteChatProduct[]; costRub?: number; sync?: SiteChatMessage['amoSync'] } = {},
  ): Promise<SiteChatMessage> {
    const { rows } = await this.db.query(
      `INSERT INTO site_chat_messages (session_id, author, text, products, cost_rub, amo_sync)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [sessionId, author, text, JSON.stringify(opts.products ?? []), opts.costRub ?? 0, opts.sync ?? 'pending'],
    );
    await this.db.query('UPDATE site_chat_sessions SET last_seen_at = now() WHERE id = $1', [sessionId]);
    return message(rows[0] as Record<string, unknown>);
  }

  async messages(sessionId: string, afterId = 0, limit = 200): Promise<SiteChatMessage[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM site_chat_messages WHERE session_id = $1 AND id > $2 ORDER BY id LIMIT $3',
      [sessionId, afterId, limit],
    );
    return rows.map((r) => message(r as Record<string, unknown>));
  }

  async countMessages(sessionId: string, author?: SiteChatAuthor): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM site_chat_messages WHERE session_id = $1 ${author ? 'AND author = $2' : ''}`,
      author ? [sessionId, author] : [sessionId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Когда клиент писал в последний раз — защита от флуда (не чаще 1 сообщения в 3 с). */
  async lastClientMessageAt(sessionId: string): Promise<Date | null> {
    const { rows } = await this.db.query<{ at: Date | null }>(
      `SELECT max(created_at) AS at FROM site_chat_messages WHERE session_id = $1 AND author = 'client'`,
      [sessionId],
    );
    return rows[0]?.at ?? null;
  }

  /** Расход канала site за московские сутки (бюджет в настройках). */
  async costToday(accountId: number, now: Date = new Date()): Promise<number> {
    const { rows } = await this.db.query<{ sum: string | null }>(
      `SELECT sum(m.cost_rub)::text AS sum FROM site_chat_messages m
         JOIN site_chat_sessions s ON s.id = m.session_id
        WHERE s.account_id = $1 AND m.author = 'agent'
          AND (m.created_at AT TIME ZONE 'Europe/Moscow')::date = ($2::timestamptz AT TIME ZONE 'Europe/Moscow')::date`,
      [accountId, now],
    );
    return Number(rows[0]?.sum ?? 0);
  }

  async setState(id: string, state: SiteChatState, reason: string | null = null): Promise<void> {
    await this.db.query(
      `UPDATE site_chat_sessions SET state = $2, handoff_reason = coalesce($3, handoff_reason),
              closed_at = CASE WHEN $2 IN ('closed', 'handed_off') THEN coalesce(closed_at, now()) ELSE closed_at END
        WHERE id = $1`,
      [id, state, reason],
    );
  }

  /** Сводка для менеджера: текст и отметка «записать в amoCRM» (повторный вызов обновляет то же примечание). */
  async setSummary(id: string, text: string, opts: { task?: boolean } = {}): Promise<void> {
    await this.db.query(
      `UPDATE site_chat_sessions SET summary_text = $2, summary_sync = 'pending',
              task_sync = CASE WHEN $3 AND task_sync = 'none' THEN 'pending' ELSE task_sync END
        WHERE id = $1`,
      [id, text, opts.task ?? false],
    );
  }

  async requestTask(id: string): Promise<void> {
    await this.db.query(`UPDATE site_chat_sessions SET task_sync = 'pending' WHERE id = $1 AND task_sync = 'none'`, [id]);
  }

  /** Активные сессии без сообщений дольше `idleMs` и с хотя бы одним сообщением клиента — закрыть. */
  async idle(accountId: number, idleMs: number, now: Date = new Date(), limit = 50): Promise<SiteChatSession[]> {
    const { rows } = await this.db.query(
      `SELECT s.* FROM site_chat_sessions s
        WHERE s.account_id = $1 AND s.state = 'active' AND s.last_seen_at < $2
          AND EXISTS (SELECT 1 FROM site_chat_messages m WHERE m.session_id = s.id AND m.author = 'client')
        ORDER BY s.last_seen_at LIMIT $3`,
      [accountId, new Date(now.getTime() - idleMs), limit],
    );
    return rows.map((r) => session(r as Record<string, unknown>));
  }

  /** Сессии, которым пора писать в amoCRM: заявка, примечания, сводка или задача. */
  async dueForSync(now: Date = new Date(), limit = 50): Promise<SiteChatSession[]> {
    const { rows } = await this.db.query(
      `SELECT s.* FROM site_chat_sessions s
        WHERE s.state <> 'spam' AND s.amo_next_try_at <= $1
          AND (s.amo_sync = 'pending' OR s.summary_sync = 'pending' OR s.task_sync = 'pending'
               OR (s.amo_sync = 'sent' AND EXISTS (SELECT 1 FROM site_chat_messages m WHERE m.session_id = s.id AND m.amo_sync = 'pending')))
        ORDER BY s.amo_next_try_at LIMIT $2`,
      [now, limit],
    );
    return rows.map((r) => session(r as Record<string, unknown>));
  }

  async markLeadCreated(id: string, a: { uid: string | null; leadId: number; contactId: number | null }): Promise<void> {
    await this.db.query(
      `UPDATE site_chat_sessions SET amo_unsorted_uid = $2, amo_lead_id = $3, amo_contact_id = $4, amo_sync = 'sent',
              amo_error = NULL, amo_attempts = 0, amo_next_try_at = now()
        WHERE id = $1`,
      [id, a.uid, a.leadId, a.contactId],
    );
  }

  /** Неудача записи в amoCRM: следующий повтор по расписанию, после 4 попыток — failed. */
  async markSyncFailed(id: string, error: string, now: Date = new Date()): Promise<{ failed: boolean; attempts: number }> {
    const { rows } = await this.db.query<{ amo_attempts: number; amo_sync: string }>(
      `UPDATE site_chat_sessions
          SET amo_attempts = amo_attempts + 1,
              amo_error = $2,
              amo_sync = CASE WHEN amo_sync = 'pending' AND amo_attempts + 1 >= $4 THEN 'failed' ELSE amo_sync END,
              amo_next_try_at = $3::timestamptz + make_interval(mins => (ARRAY[1,5,15,60])[LEAST(amo_attempts + 1, 4)])
        WHERE id = $1
        RETURNING amo_attempts, amo_sync`,
      [id, error.slice(0, 1000), now, SITE_SYNC_MAX_ATTEMPTS],
    );
    const r = rows[0];
    return { failed: r?.amo_sync === 'failed', attempts: Number(r?.amo_attempts ?? 0) };
  }

  async markMessagesSynced(ids: number[], noteId: number | null, sync: SiteChatMessage['amoSync'] = 'sent'): Promise<void> {
    if (!ids.length) return;
    await this.db.query('UPDATE site_chat_messages SET amo_note_id = $2, amo_sync = $3 WHERE id = ANY($1::bigint[])', [ids, noteId, sync]);
  }

  async markSummarySynced(id: string, noteId: number): Promise<void> {
    await this.db.query(`UPDATE site_chat_sessions SET summary_sync = 'sent', summary_note_id = $2 WHERE id = $1`, [id, noteId]);
  }

  async markTaskSynced(id: string, taskId: number | null): Promise<void> {
    await this.db.query(`UPDATE site_chat_sessions SET task_sync = 'sent', task_id = $2 WHERE id = $1`, [id, taskId]);
  }

  /** Для виджета amo и аналитики: сессии аккаунта, новые сверху. */
  async list(accountId: number, limit = 50): Promise<(SiteChatSession & { messages: number })[]> {
    const { rows } = await this.db.query(
      `SELECT s.*, (SELECT count(*) FROM site_chat_messages m WHERE m.session_id = s.id)::int AS messages
         FROM site_chat_sessions s WHERE s.account_id = $1 ORDER BY s.created_at DESC LIMIT $2`,
      [accountId, limit],
    );
    return rows.map((r) => ({ ...session(r as Record<string, unknown>), messages: Number((r as { messages: number }).messages) }));
  }

  /** Удаление данных аккаунта (кнопка «Удалить все данные»). */
  async purge(accountId: number): Promise<void> {
    await this.db.query('DELETE FROM site_chat_sessions WHERE account_id = $1', [accountId]);
  }
}
