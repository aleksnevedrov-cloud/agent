import { EventEmitter } from 'node:events';
import { normalizeRuPhone, type AccountsRepo, type SettingsRepo, type SiteChatMessage, type SiteChatRepo, type SiteChatSession, type WidgetSettings } from '@core/db';
import type { Env } from '@core/shared';
import { runSiteTurn, withinHours, type SiteTurnDeps, type SiteTurnOutcome } from '@retail/agent';
import { z } from 'zod';

/**
 * RFD-SITE-CHAT-AGENT: приём формы и сообщений из окна чата на сайте.
 * Порядок: проверка → строка в базе → ответ окну; заявку в amoCRM пишет воркер очередью, агент отвечает
 * в фоне и публикует ответ подписчикам SSE этой сессии. Сбой одной части не останавливает другую.
 */

export const SESSION_TTL_DAYS = 7;
/** Лимиты из раздела 6 ТЗ. */
export const LIMITS = {
  sessionsPerIp10Min: 3,
  sessionsPerIpDay: 20,
  messagesPerSession: 30,
  messageMinIntervalMs: 3000,
  minFormSeconds: 3,
  duplicateWindowMs: 10 * 60_000,
  messageMaxLen: 2000,
} as const;

export const sessionInput = z
  .object({
    name: z.string().trim().min(2).max(60),
    phone: z.string().trim().min(5).max(30),
    email: z.string().trim().email().max(120),
    message: z.string().trim().min(2).max(LIMITS.messageMaxLen),
    consent: z.literal(true),
    /** Ловушка для ботов: заполнено → ничего не создаём. */
    website: z.string().max(200).optional(),
    /** Когда клиент открыл форму (мс): отправка быстрее 3 с — спам. */
    opened_at: z.number().int().optional(),
    page_url: z.string().max(2000).optional(),
    page_title: z.string().max(300).optional(),
    referrer: z.string().max(2000).optional(),
    utm: z.record(z.string().max(100), z.string().max(300)).optional(),
    ym_uid: z.string().max(64).optional(),
    ga_cid: z.string().max(64).optional(),
  })
  .strict();
export type SessionInput = z.infer<typeof sessionInput>;

export const messageInput = z.object({ session: z.string().regex(/^[0-9a-f]{32}$/), text: z.string().trim().min(1).max(LIMITS.messageMaxLen) }).strict();

export interface SiteChatPublicMessage {
  id: number;
  author: SiteChatMessage['author'];
  text: string;
  products: SiteChatMessage['products'];
  at: string;
}

export const publicMessage = (m: SiteChatMessage): SiteChatPublicMessage => ({ id: m.id, author: m.author, text: m.text, products: m.products, at: m.createdAt.toISOString() });

export type SiteEvent = { type: 'message'; message: SiteChatPublicMessage } | { type: 'typing'; on: boolean } | { type: 'state'; state: SiteChatSession['state'] };

export interface SiteChatServiceDeps {
  env: Pick<Env, 'SITE_CHAT_ACCOUNT_ID'>;
  accounts: Pick<AccountsRepo, 'get'>;
  settings: Pick<SettingsRepo, 'get' | 'listAccountIds'>;
  siteChat: SiteChatRepo;
  turn: SiteTurnDeps;
  log?: { error(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  now?(): Date;
}

export type StartResult =
  | { ok: true; session: SiteChatSession; messages: SiteChatPublicMessage[]; duplicate: boolean }
  | { ok: false; status: 400 | 429 | 503; error: string; issues?: unknown };

export class SiteChatService {
  private readonly bus = new EventEmitter();
  private readonly running = new Set<Promise<unknown>>();

  constructor(private readonly d: SiteChatServiceDeps) {
    this.bus.setMaxListeners(0);
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  /** Аккаунт, чей чат обслуживает сайт: из .env или единственный / первый с включённым чатом. */
  async account(): Promise<{ accountId: number; settings: WidgetSettings } | null> {
    const ids = this.d.env.SITE_CHAT_ACCOUNT_ID ? [this.d.env.SITE_CHAT_ACCOUNT_ID] : await this.d.settings.listAccountIds();
    let first: { accountId: number; settings: WidgetSettings } | null = null;
    for (const accountId of ids) {
      const acc = await this.d.accounts.get(accountId);
      if (!acc || acc.uninstalledAt) continue;
      const { settings } = await this.d.settings.get(accountId);
      if (settings.siteChat.enabled) return { accountId, settings };
      first ??= { accountId, settings };
    }
    return first;
  }

  /** Что окну нужно знать: включён ли чат, онлайн ли агент сейчас, тексты и всплывание. Контактов и ключей здесь нет. */
  async config() {
    const a = await this.account();
    const sc = a?.settings.siteChat;
    if (!a || !sc || !sc.enabled) return { enabled: false as const };
    const now = this.now();
    const online = sc.agentEnabled && a.settings.enabled && withinHours(sc.hoursFrom, sc.hoursTo, now);
    return {
      enabled: true as const,
      online,
      texts: { greeting: sc.greeting, autoReply: online ? sc.autoReply : sc.offHoursText, fallbackPhone: sc.fallbackPhone },
      popup: sc.popup,
      privacyUrl: sc.privacyUrl,
      limits: { messageMaxLen: LIMITS.messageMaxLen, messageMinIntervalMs: LIMITS.messageMinIntervalMs },
      sessionTtlDays: SESSION_TTL_DAYS,
    };
  }

  async start(raw: unknown, meta: { ip: string | null; userAgent: string | null }): Promise<StartResult> {
    const parsed = sessionInput.safeParse(raw);
    if (!parsed.success) return { ok: false, status: 400, error: 'invalid_form', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
    const i = parsed.data;
    const phone = normalizeRuPhone(i.phone);
    if (!phone) return { ok: false, status: 400, error: 'invalid_form', issues: [{ path: 'phone', message: 'Нужен российский номер из 11 цифр' }] };
    const a = await this.account();
    if (!a || !a.settings.siteChat.enabled) return { ok: false, status: 503, error: 'disabled' };
    const now = this.now();

    // Ловушка заполнена — отвечаем «ок», ничего не создаём (бот не должен понять, что его раскусили).
    if (i.website && i.website.trim()) {
      const fake: SiteChatSession = { id: 'f'.repeat(32) } as SiteChatSession;
      return { ok: true, session: fake, messages: [], duplicate: false };
    }
    if (meta.ip) {
      const [m10, day] = await Promise.all([this.d.siteChat.countByIp(meta.ip, 10 * 60_000, now), this.d.siteChat.countByIp(meta.ip, 24 * 3600_000, now)]);
      if (m10 >= LIMITS.sessionsPerIp10Min || day >= LIMITS.sessionsPerIpDay) return { ok: false, status: 429, error: 'too_many_sessions' };
    }
    // Та же форма повторно (тот же телефон и текст за 10 минут) — возвращаем прежнюю сессию, вторая заявка не создаётся.
    const dup = await this.d.siteChat.findDuplicate(a.accountId, phone, i.message, LIMITS.duplicateWindowMs, now);
    if (dup) return { ok: true, session: dup, messages: (await this.d.siteChat.messages(dup.id)).map(publicMessage), duplicate: true };

    const tooFast = i.opened_at !== undefined && now.getTime() - i.opened_at < LIMITS.minFormSeconds * 1000 && now.getTime() - i.opened_at >= 0;
    const session = await this.d.siteChat.create({
      accountId: a.accountId,
      name: i.name,
      phone,
      email: i.email,
      consentAt: now,
      pageUrl: i.page_url ?? null,
      pageTitle: i.page_title ?? null,
      referrer: i.referrer ?? null,
      utm: pickUtm(i.utm),
      ymUid: i.ym_uid ?? null,
      gaCid: i.ga_cid ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
      state: tooFast ? 'spam' : 'active',
    });
    const first = await this.d.siteChat.addMessage(session.id, 'client', i.message, { sync: tooFast ? 'skipped' : 'pending' });
    const messages = [publicMessage(first)];
    if (!tooFast) {
      // Приветствие — сразу, чтобы окно не было пустым, пока модель думает. В amoCRM оно не идёт.
      const sc = a.settings.siteChat;
      const online = sc.agentEnabled && a.settings.enabled && withinHours(sc.hoursFrom, sc.hoursTo, now);
      if (online && sc.greeting.trim()) messages.push(publicMessage(await this.d.siteChat.addMessage(session.id, 'agent', sc.greeting, { sync: 'skipped' })));
      this.replyLater(session.id, i.message);
    }
    return { ok: true, session, messages, duplicate: false };
  }

  async message(raw: unknown): Promise<{ ok: true; message: SiteChatPublicMessage } | { ok: false; status: 400 | 404 | 429; error: string }> {
    const parsed = messageInput.safeParse(raw);
    if (!parsed.success) return { ok: false, status: 400, error: 'invalid_message' };
    const { session: id, text } = parsed.data;
    const session = await this.d.siteChat.get(id);
    if (!session || this.expired(session)) return { ok: false, status: 404, error: 'no_session' };
    if (session.state === 'spam') {
      // Спам: принимаем молча, ничего не храним и не отвечаем.
      return { ok: true, message: { id: 0, author: 'client', text, products: [], at: this.now().toISOString() } };
    }
    const last = await this.d.siteChat.lastClientMessageAt(id);
    if (last && this.now().getTime() - last.getTime() < LIMITS.messageMinIntervalMs) return { ok: false, status: 429, error: 'too_fast' };
    if ((await this.d.siteChat.countMessages(id, 'client')) >= LIMITS.messagesPerSession) return { ok: false, status: 429, error: 'session_limit' };
    const m = await this.d.siteChat.addMessage(id, 'client', text, { sync: 'pending' });
    this.replyLater(id, text);
    return { ok: true, message: publicMessage(m) };
  }

  async history(id: string, after = 0): Promise<{ session: SiteChatSession; messages: SiteChatPublicMessage[] } | null> {
    const session = await this.d.siteChat.get(id);
    if (!session || session.state === 'spam' || this.expired(session)) return null;
    await this.d.siteChat.touch(id, this.now());
    return { session, messages: (await this.d.siteChat.messages(id, after)).map(publicMessage) };
  }

  private expired(s: SiteChatSession): boolean {
    return this.now().getTime() - s.createdAt.getTime() > SESSION_TTL_DAYS * 24 * 3600_000;
  }

  subscribe(sessionId: string, cb: (e: SiteEvent) => void): () => void {
    this.bus.on(sessionId, cb);
    return () => this.bus.off(sessionId, cb);
  }

  publish(sessionId: string, e: SiteEvent): void {
    this.bus.emit(sessionId, e);
  }

  /** Ответ агента в фоне: окну уходит «печатает…», затем сообщение (или автоответ). */
  private replyLater(sessionId: string, text: string): void {
    this.publish(sessionId, { type: 'typing', on: true });
    const p = runSiteTurn(this.d.turn, sessionId, text)
      .then((out: SiteTurnOutcome) => {
        if (out.kind === 'skipped') return;
        this.publish(sessionId, { type: 'message', message: publicMessage(out.message) });
        if (out.kind === 'handoff') this.publish(sessionId, { type: 'state', state: 'handed_off' });
      })
      .catch((err: unknown) => this.d.log?.error({ err, sessionId }, 'site-chat: ответ агента не удался'))
      .finally(() => {
        this.publish(sessionId, { type: 'typing', on: false });
        this.running.delete(p);
      });
    this.running.add(p);
  }

  /** Дождаться фоновых ответов (тесты и корректное завершение). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
function pickUtm(utm: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of UTM_KEYS) if (utm?.[k]) out[k] = utm[k].slice(0, 300);
  return out;
}
