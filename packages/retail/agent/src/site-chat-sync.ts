import type { AmoApiClient } from '@core/amo';
import { resolveTaskAssignee, fieldValues } from '@core/amo';
import { SITE_SYNC_MAX_ATTEMPTS, type JournalRepo, type SettingsRepo, type SiteChatMessage, type SiteChatRepo, type SiteChatSession, type WidgetSettings } from '@core/db';
import { closeIdleSession, type SiteTurnDeps } from './site-chat.ts';

/**
 * RFD-SITE-CHAT-AGENT: запись чата сайта в amoCRM очередью воркера (раз в 30 с).
 * Порядок на сессию: заявка в «Неразобранном» (контакт по телефону → по почте → новый) → примечание
 * «Сообщение с сайта:» → примечания переписки парами «вопрос → ответ» → сводка Аммы → задача «Перезвонить».
 * Ошибка amoCRM → повтор через 1, 5, 15, 60 минут; после 4 неудач — failed и запись в журнал (kind=error).
 * Агент в окне отвечает независимо от того, дошла ли запись.
 */

export const SITE_CHAT_SYNC_JOB = 'site-chat-sync';
export const SITE_CHAT_SYNC_EVERY_MS = 30_000;
export const SITE_CHAT_IDLE_JOB = 'site-chat-idle';
export const SITE_CHAT_IDLE_EVERY_MS = 60_000;
/** Хвост переписки без ответа агента уходит в заявку, когда клиент молчит дольше этого. */
const TRAILING_AFTER_MS = 2 * 60_000;
export const SITE_SOURCE_UID = 'site-chat';

export type SiteSyncApi = Pick<AmoApiClient, 'findContactsByPhone' | 'findContactsByEmail' | 'createUnsortedForm' | 'addContactFields' | 'addLeadNote' | 'updateLeadNote' | 'createTask' | 'getLead' | 'listUsers' | 'getLeadNotes'> & { readonly domain: string };

export interface SiteSyncDeps {
  siteChat: SiteChatRepo;
  settings: SettingsRepo;
  journal: JournalRepo;
  amo(accountId: number): Promise<{ api: SiteSyncApi }>;
  now?(): Date;
}

export interface SiteSyncResult {
  sessions: number;
  leads: number;
  notes: number;
  summaries: number;
  tasks: number;
  failed: number;
  errors: number;
}

const MSK = 'Europe/Moscow';
const hhmm = (d: Date) => new Intl.DateTimeFormat('ru-RU', { timeZone: MSK, hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(/^24/, '00');

export function leadName(s: Pick<SiteChatSession, 'name'>, firstText: string): string {
  const head = firstText.replace(/\s+/g, ' ').trim().slice(0, 60);
  return `Чат с сайта: ${s.name}${head ? ` — ${head}` : ''}`;
}

/** Примечание с первым сообщением: текст, страница, заголовок, переход, UTM — видно до нажатия «Принять». */
export function firstNoteText(s: SiteChatSession, text: string): string {
  const lines = ['Сообщение с сайта:', text.trim()];
  const meta: string[] = [];
  if (s.pageUrl) meta.push(`Страница: ${s.pageUrl}${s.pageTitle ? ` («${s.pageTitle}»)` : ''}`);
  if (s.referrer) meta.push(`Переход: ${s.referrer}`);
  const utm = Object.entries(s.utm).map(([k, v]) => `${k}=${v}`);
  if (utm.length) meta.push(`UTM: ${utm.join(', ')}`);
  if (s.ymUid) meta.push(`ClientID Метрики: ${s.ymUid}`);
  if (meta.length) lines.push('', ...meta);
  return lines.join('\n');
}

const who = { client: 'Клиент', agent: 'Амма', system: 'Система', manager: 'Менеджер' } as const;

export function pairNoteText(messages: SiteChatMessage[]): string {
  return ['Чат сайта', ...messages.map((m) => `[${hhmm(m.createdAt)}] ${who[m.author]}: ${m.text}`)].join('\n');
}

/**
 * Разбивка ожидающих сообщений на примечания: клиентские копятся до ответа агента; хвост без ответа
 * уходит, если диалог закрыт/передан или клиент молчит дольше TRAILING_AFTER_MS.
 */
export function groupForNotes(pending: SiteChatMessage[], session: Pick<SiteChatSession, 'state'>, now: Date): SiteChatMessage[][] {
  const groups: SiteChatMessage[][] = [];
  let cur: SiteChatMessage[] = [];
  for (const m of pending) {
    cur.push(m);
    if (m.author === 'agent') {
      groups.push(cur);
      cur = [];
    }
  }
  const last = cur.at(-1);
  if (last && (session.state !== 'active' || now.getTime() - last.createdAt.getTime() >= TRAILING_AFTER_MS)) groups.push(cur);
  return groups;
}

export async function syncSession(d: SiteSyncDeps, api: SiteSyncApi, settings: WidgetSettings, s: SiteChatSession, out: SiteSyncResult): Promise<void> {
  const now = d.now?.() ?? new Date();
  const sc = settings.siteChat;
  const messages = await d.siteChat.messages(s.id);
  const first = messages.find((m) => m.author === 'client');

  // 1. Заявка в «Неразобранном».
  if (s.amoSync === 'pending' && !s.amoLeadId) {
    const byPhone = await api.findContactsByPhone(s.phone);
    // По почте — только контакт без телефона: общий ящик семьи или фирмы не должен приклеивать заявку к чужому человеку
    // (приёмка 20.11.2026: тестовая заявка легла на «Сергея», которому раньше дописали test@example.com).
    const byEmail = byPhone.length || !s.email ? [] : (await api.findContactsByEmail(s.email)).filter((c) => fieldValues(c.custom_fields_values, 'PHONE').length === 0);
    const existing = byPhone[0] ?? byEmail[0] ?? null;
    const r = await api.createUnsortedForm({
      sourceName: sc.sourceName,
      sourceUid: SITE_SOURCE_UID,
      pipelineId: sc.pipelineId,
      leadName: leadName(s, first?.text ?? ''),
      tag: sc.tag,
      contact: existing ? { id: existing.id } : { name: s.name, phone: s.phone, ...(s.email ? { email: s.email } : {}) },
      metadata: { formId: SITE_SOURCE_UID, formName: 'Чат на сайте', formPage: s.pageUrl ?? 'https://www.rf-dveri.ru/', referer: s.referrer, ip: s.ip, sentAt: s.createdAt },
    });
    if (!r.leadId) throw new Error('amo не вернул id сделки для заявки');
    await d.siteChat.markLeadCreated(s.id, { uid: r.uid, leadId: r.leadId, contactId: existing?.id ?? r.contactId });
    s = { ...s, amoLeadId: r.leadId, amoContactId: existing?.id ?? r.contactId, amoSync: 'sent' };
    out.leads += 1;
    // Контакт уже был: новые телефон/почта дописываются, старые не стираются (сбой — не повод откатывать заявку).
    if (existing) await api.addContactFields(existing.id, { phone: s.phone, ...(s.email ? { email: s.email } : {}) }).catch(() => false);
  }
  if (!s.amoLeadId) return;
  const leadId = s.amoLeadId;

  // 2. Примечания: первое сообщение отдельно, дальше парами.
  const pending = messages.filter((m) => m.amoSync === 'pending');
  if (first && pending.some((m) => m.id === first.id)) {
    const noteId = await api.addLeadNote(leadId, firstNoteText(s, first.text));
    await d.siteChat.markMessagesSynced([first.id], noteId);
    out.notes += 1;
  }
  const rest = pending.filter((m) => m.id !== first?.id);
  for (const group of groupForNotes(rest, s, now)) {
    const noteId = await api.addLeadNote(leadId, pairNoteText(group));
    await d.siteChat.markMessagesSynced(
      group.map((m) => m.id),
      noteId,
    );
    out.notes += 1;
  }

  // 3. Сводка Аммы — одно примечание, обновляется.
  if (s.summarySync === 'pending' && s.summaryText) {
    if (s.summaryNoteId) {
      await api.updateLeadNote(leadId, s.summaryNoteId, s.summaryText);
      await d.siteChat.markSummarySynced(s.id, s.summaryNoteId);
    } else {
      const noteId = await api.addLeadNote(leadId, s.summaryText);
      await d.siteChat.markSummarySynced(s.id, noteId);
    }
    out.summaries += 1;
  }

  // 4. Задача «Перезвонить клиенту с сайта» — ответственному заявки, иначе «Администратору для задач».
  if (s.taskSync === 'pending') {
    const h = settings.handoff;
    const a = await resolveTaskAssignee(api, leadId, { forcedUserId: h.responsibleUserId, fallbackUserId: h.fallbackUserId }).catch(() => null);
    const cfg = settings.tasks?.callback ?? { taskTypeId: 1, deadlineMin: 15 };
    const taskId = await api.createTask({
      leadId,
      text: `Перезвонить клиенту с сайта: ${s.name}, +${s.phone}${s.handoffReason ? ` (${reasonLabel(s.handoffReason)})` : ''}. Сводка — в примечании заявки.`,
      completeTill: new Date(now.getTime() + Math.min(cfg.deadlineMin, 15) * 60_000),
      taskTypeId: cfg.taskTypeId,
      ...(a?.userId ? { responsibleUserId: a.userId } : {}),
    });
    await d.siteChat.markTaskSynced(s.id, taskId);
    out.tasks += 1;
  }
}

function reasonLabel(reason: string): string {
  const map: Record<string, string> = {
    client_request: 'просит менеджера',
    callback: 'заказ звонка с сайта',
    manager: 'менеджер ответил в чате',
    complaint: 'жалоба',
    discount: 'вопрос о скидке',
    custom_order: 'нестандартный заказ',
    legal_entity: 'юрлицо',
    wholesale: 'опт',
    return: 'возврат',
    no_answer: 'агент не знает ответа',
    reply_limit: 'лимит ответов агента',
    idle: 'клиент ушёл',
    other: 'другое',
  };
  return map[reason] ?? reason;
}

/** Один проход очереди: все сессии, которым пора писать в amoCRM. */
export async function runSiteChatSync(d: SiteSyncDeps): Promise<SiteSyncResult> {
  const now = d.now?.() ?? new Date();
  const out: SiteSyncResult = { sessions: 0, leads: 0, notes: 0, summaries: 0, tasks: 0, failed: 0, errors: 0 };
  const due = await d.siteChat.dueForSync(now);
  const apis = new Map<number, { api: SiteSyncApi; settings: WidgetSettings }>();
  for (const s of due) {
    out.sessions += 1;
    try {
      let a = apis.get(s.accountId);
      if (!a) {
        a = { api: (await d.amo(s.accountId)).api, settings: (await d.settings.get(s.accountId)).settings };
        apis.set(s.accountId, a);
      }
      await syncSession(d, a.api, a.settings, s, out);
    } catch (err) {
      const message = (err as Error).message;
      // Заявку отклонили или удалили в amoCRM (приёмка 20.11.2026: тестовые заявки отклоняли, примечания отвечали HTTP 400) —
      // повторять нечего, в журнал ошибок не пишем.
      if (s.amoLeadId && /HTTP (400|404)/.test(message)) {
        const lead = await apis.get(s.accountId)?.api.getLead(s.amoLeadId).catch(() => undefined);
        if (lead === null) {
          await d.siteChat.markLeadGone(s.id, `заявка #${s.amoLeadId} удалена или отклонена в amoCRM`);
          out.failed += 1;
          continue;
        }
      }
      out.errors += 1;
      const r = await d.siteChat.markSyncFailed(s.id, message, now);
      if (r.failed || r.attempts === SITE_SYNC_MAX_ATTEMPTS) {
        out.failed += 1;
        await d.journal.add({
          accountId: s.accountId,
          leadId: s.amoLeadId ?? undefined,
          kind: 'error',
          summary: `Чат сайта: запись в amoCRM не удалась после ${r.attempts} попыток — ${message}`.slice(0, 2000),
          details: { channel: 'site', sessionId: s.id, attempts: r.attempts, stage: s.amoLeadId ? 'notes' : 'lead' },
        });
      }
    }
  }
  return out;
}

/** Примечание менеджера, которое уходит клиенту в окно: начинается с «Клиенту:». */
export const MANAGER_PREFIX = /^\s*клиенту\s*[:：]\s*/iu;
/** Окно считается закрытым, если пинга нет дольше этого времени (пинг SSE — 25 с, опрос — 3 с). */
export const PRESENCE_OFFLINE_MS = 90_000;

export interface SiteLiveResult {
  sessions: number;
  managerMessages: number;
  presenceNotes: number;
  /** Заявки, удалённые или отклонённые в amoCRM: диалог закрыт, больше не опрашивается. */
  gone: number;
  errors: number;
}

/** Ошибки живого прохода пишутся в журнал не чаще раза в 15 минут на диалог (проход идёт каждые 30 с). */
const liveErrorAt = new Map<string, number>();

/**
 * Дополнение 20.11.2026: живые диалоги с заявкой — раз в 30 с.
 * 1. Ответы менеджера: примечание в заявке, начинающееся с «Клиенту:», показывается в окне сайта с именем автора;
 *    агент после этого замолкает (handed_off / manager), ответы клиента по-прежнему падают в заявку.
 * 2. Присутствие: окно пингует сервер; нет пинга 90 с → примечание «Клиент закрыл сайт в ЧЧ:ММ», вернулся → «снова на сайте».
 */
export async function runSiteChatLive(d: SiteSyncDeps): Promise<SiteLiveResult> {
  const now = d.now?.() ?? new Date();
  const out: SiteLiveResult = { sessions: 0, managerMessages: 0, presenceNotes: 0, gone: 0, errors: 0 };
  const apis = new Map<number, { api: SiteSyncApi; users: Map<number, string> | null }>();
  for (let s of await d.siteChat.liveWithLead(now)) {
    const leadId = s.amoLeadId;
    if (!leadId) continue;
    out.sessions += 1;
    try {
      let a = apis.get(s.accountId);
      if (!a) {
        a = { api: (await d.amo(s.accountId)).api, users: null };
        apis.set(s.accountId, a);
      }
      // 1. Ответы менеджера.
      // Запас 5 минут на расхождение часов amo и сервера; дубли отсекает hasNote по id примечания.
      const since = ((s.notesCheckedAt ?? s.createdAt).getTime() - 5 * 60_000) / 1000;
      const notes = (await a.api.getLeadNotes(leadId, 50)).filter((n) => n.note_type === 'common' && n.created_at >= Math.floor(since) && MANAGER_PREFIX.test(n.params?.text ?? ''));
      let checked = s.notesCheckedAt ?? s.createdAt;
      for (const n of notes.sort((x, y) => x.created_at - y.created_at)) {
        const at = new Date(n.created_at * 1000);
        if (at > checked) checked = at;
        if (await d.siteChat.hasNote(s.id, n.id)) continue;
        const text = (n.params?.text ?? '').replace(MANAGER_PREFIX, '').trim();
        if (!text) continue;
        if (!a.users) a.users = new Map((await a.api.listUsers().catch(() => [])).map((u) => [u.id, u.name]));
        await d.siteChat.addMessage(s.id, 'manager', text, { sync: 'skipped', amoNoteId: n.id, authorName: a.users.get(n.created_by) ?? null });
        out.managerMessages += 1;
        if (s.state === 'active') {
          await d.siteChat.setState(s.id, 'handed_off', 'manager');
          s = { ...s, state: 'handed_off', handoffReason: 'manager' };
        }
      }
      if (checked > (s.notesCheckedAt ?? new Date(0))) await d.siteChat.setNotesChecked(s.id, checked);
      // 2. Присутствие.
      if (s.seenAt) {
        const online = now.getTime() - s.seenAt.getTime() < PRESENCE_OFFLINE_MS;
        if (!online && s.presenceNoted !== 'offline') {
          await a.api.addLeadNote(leadId, `Чат сайта: клиент закрыл сайт в ${hhmm(s.seenAt)}.`);
          await d.siteChat.setPresenceNoted(s.id, 'offline');
          out.presenceNotes += 1;
        } else if (online && s.presenceNoted === 'offline') {
          await a.api.addLeadNote(leadId, `Чат сайта: клиент снова на сайте (${hhmm(now)}), окно чата открыто.`);
          await d.siteChat.setPresenceNoted(s.id, 'online');
          out.presenceNotes += 1;
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      // Заявку отклонили или удалили (на приёмке 20.11.2026 отклонённые тестовые заявки давали ошибку каждые 30 с).
      if (/HTTP (400|404)/.test(message)) {
        const lead = await apis.get(s.accountId)?.api.getLead(leadId).catch(() => undefined);
        if (lead === null) {
          await d.siteChat.markLeadGone(s.id, `заявка #${leadId} удалена или отклонена в amoCRM`);
          out.gone += 1;
          continue;
        }
      }
      out.errors += 1;
      const last = liveErrorAt.get(s.id) ?? 0;
      if (now.getTime() - last >= 15 * 60_000) {
        liveErrorAt.set(s.id, now.getTime());
        await d.journal.add({ accountId: s.accountId, leadId, kind: 'error', summary: `Чат сайта: ответы менеджера / присутствие — ${message}`.slice(0, 2000), details: { channel: 'site', sessionId: s.id } });
      }
    }
  }
  return out;
}

/** Клиенты, которые ушли: закрыть диалог, сводка и задача — по каждому аккаунту с включённым чатом. */
export async function runSiteChatIdleAll(d: SiteTurnDeps & { accountIds(): Promise<number[]> }): Promise<{ accounts: number; closed: number }> {
  const now = d.now?.() ?? new Date();
  let closed = 0;
  let accounts = 0;
  for (const accountId of await d.accountIds()) {
    const { settings } = await d.settings.get(accountId);
    if (!settings.siteChat.enabled) continue;
    accounts += 1;
    for (const s of await d.siteChat.idle(accountId, settings.siteChat.idleCloseMin * 60_000, now)) {
      if ((await closeIdleSession(d, s, settings)) === 'closed') closed += 1;
    }
  }
  return { accounts, closed };
}
