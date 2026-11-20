import type { CatalogRepo } from '@retail/catalog';
import type { JournalRepo, SettingsRepo, SiteChatMessage, SiteChatProduct, SiteChatRepo, SiteChatSession, WidgetSettings } from '@core/db';
import type { KnowledgeRepo } from '@retail/knowledge';
import type { PricingRules } from '@retail/pricing';
import { formatSiteSummary, InMemoryMemory, pricingCodesHint, SITE_TOOLS, type CrmPort, type LeadContext, type SiteLeadPort, type ToolContext } from '@core/tools';
import type { HistoryMessage, TurnResult } from './orchestrator.ts';
import type { AiProvider } from './provider.ts';
import { resolveRoute } from './route.ts';
import { summarizeDialog } from './summary.ts';

/**
 * RFD-SITE-CHAT-AGENT: канал `site` — агент розницы отвечает клиенту в окне чата на rf-dveri.ru.
 * Тот же оркестратор, каталог, база знаний, «Характер» и «Правила магазина»; новое — правила канала,
 * ограниченный набор инструментов (SITE_TOOLS) и запись переписки в заявку «Неразобранного» через очередь.
 * Телефон, почта и имя клиента модели не передаются (152-ФЗ) — только признак «контакты есть в заявке».
 */

export interface SiteTurnDeps {
  ai: AiProvider;
  settings: SettingsRepo;
  journal: JournalRepo;
  siteChat: SiteChatRepo;
  catalog: CatalogRepo;
  knowledge: KnowledgeRepo;
  pricing(accountId: number): Promise<PricingRules | null>;
  components?: ToolContext['components'];
  now?(): Date;
}

export type SiteTurnOutcome =
  | { kind: 'reply'; message: SiteChatMessage }
  | { kind: 'handoff'; message: SiteChatMessage; reason: string }
  | { kind: 'auto'; message: SiteChatMessage; why: 'agent_off' | 'off_hours' | 'budget' | 'no_llm' | 'after_handoff' }
  | { kind: 'skipped'; why: 'spam' | 'no_session' | 'site_off' };

const MSK = 'Europe/Moscow';

/** Часы ответов агента по Москве: оба пустые — круглосуточно. */
export function withinHours(from: string | null, to: string | null, now: Date): boolean {
  if (!from || !to) return true;
  const hm = new Intl.DateTimeFormat('ru-RU', { timeZone: MSK, hour: '2-digit', minute: '2-digit', hour12: false }).format(now).replace(/^24/, '00');
  return from <= to ? hm >= from && hm < to : hm >= from || hm < to;
}

/** Текст передачи менеджеру с телефоном клиента (клиенту показываем его же номер). */
export function handoffText(template: string, phone: string): string {
  const pretty = phone.length === 11 ? `+7 ${phone.slice(1, 4)} ${phone.slice(4, 7)}-${phone.slice(7, 9)}-${phone.slice(9)}` : `+${phone}`;
  return template.replace('{phone}', pretty);
}

/** История для модели: клиент → client, агент → ai; системные автоответы не показываем. */
export function siteHistory(messages: SiteChatMessage[]): HistoryMessage[] {
  return messages.filter((m) => m.author !== 'system').map((m) => ({ role: m.author === 'client' ? 'client' : 'ai', text: m.text }));
}

/** CRM-порт чата сайта: заявки в amo ещё может не быть, поэтому контекст — только из сессии. */
class SiteCrm implements CrmPort {
  constructor(
    private readonly repo: SiteChatRepo,
    private readonly session: SiteChatSession,
  ) {}
  async getContext(): Promise<LeadContext> {
    return {
      leadId: this.session.amoLeadId ?? 0,
      name: 'Чат с сайта',
      budget: null,
      statusId: null,
      pipelineId: null,
      contactName: null,
      hasPhone: true,
      hasEmail: Boolean(this.session.email),
      tags: ['Чат сайта'],
      recentNotes: [],
    };
  }
  async addNote(text: string): Promise<void> {
    await this.repo.addMessage(this.session.id, 'system', text, { sync: 'pending' });
  }
  async createTask(): Promise<void> {
    await this.repo.requestTask(this.session.id);
  }
}

async function productCards(catalog: CatalogRepo, accountId: number, sources: TurnResult['sources']): Promise<SiteChatProduct[]> {
  const ids = [...new Set(sources.filter((s) => s.type === 'product').map((s) => s.id))].slice(0, 3);
  const out: SiteChatProduct[] = [];
  for (const id of ids) {
    const p = await catalog.get(accountId, id).catch(() => null);
    if (p) out.push({ id: p.id, name: p.name, price: p.price, url: p.url, picture: p.picture });
  }
  return out;
}

/** Один ход агента в чате сайта: сообщение клиента уже записано в сессию. */
export async function runSiteTurn(d: SiteTurnDeps, sessionId: string, incoming: string): Promise<SiteTurnOutcome> {
  const now = d.now?.() ?? new Date();
  const session = await d.siteChat.get(sessionId);
  if (!session) return { kind: 'skipped', why: 'no_session' };
  if (session.state === 'spam') return { kind: 'skipped', why: 'spam' };
  const { settings } = await d.settings.get(session.accountId);
  const sc = settings.siteChat;
  if (!sc.enabled) return { kind: 'skipped', why: 'site_off' };

  const auto = async (text: string, why: Extract<SiteTurnOutcome, { kind: 'auto' }>['why']): Promise<SiteTurnOutcome> => {
    const message = await d.siteChat.addMessage(session.id, 'system', text, { sync: 'skipped' });
    return { kind: 'auto', message, why };
  };

  // После передачи менеджеру или закрытия агент товары не подбирает: сообщение дописывается в заявку.
  if (session.state !== 'active') return auto(sc.afterHandoffText, 'after_handoff');
  if (!sc.agentEnabled || !settings.enabled) return auto(sc.autoReply, 'agent_off');
  if (!withinHours(sc.hoursFrom, sc.hoursTo, now)) return auto(sc.offHoursText, 'off_hours');
  if (sc.dailyBudgetRub > 0 && (await d.siteChat.costToday(session.accountId, now)) >= sc.dailyBudgetRub) {
    await d.journal.add({ accountId: session.accountId, kind: 'blocked', summary: 'Чат сайта: бюджет канала на сегодня исчерпан, работает автоответ', details: { channel: 'site', sessionId: session.id } });
    return auto(sc.autoReply, 'budget');
  }
  const ai = await d.ai(session.accountId);
  if (!ai) {
    await d.journal.add({ accountId: session.accountId, kind: 'error', summary: 'Чат сайта: нет ключа модели — автоответ', details: { channel: 'site', sessionId: session.id } });
    return auto(sc.autoReply, 'no_llm');
  }

  const finishHandoff = async (reason: string, summary: string | null, result?: TurnResult): Promise<SiteTurnOutcome> => {
    await d.siteChat.setState(session.id, 'handed_off', reason);
    const fresh = await d.siteChat.get(session.id);
    if (!fresh?.summaryText && summary) await d.siteChat.setSummary(session.id, `Сводка Аммы (чат сайта)\n${summary}`, { task: true });
    else await d.siteChat.requestTask(session.id);
    const message = await d.siteChat.addMessage(session.id, 'agent', handoffText(sc.handoffText, session.phone), {
      costRub: result ? result.cost.usd * settings.billing.usdRubRate : 0,
      sync: 'pending',
    });
    await d.journal.add({
      accountId: session.accountId,
      leadId: session.amoLeadId ?? undefined,
      kind: 'handoff',
      summary: `Чат сайта: передача менеджеру (${reason})`,
      details: { channel: 'site', sessionId: session.id, reason, toolCalls: result?.toolCalls ?? [], provider: result?.provider, model: result?.model },
      inputTokens: result?.cost.inputTokens,
      outputTokens: result?.cost.outputTokens,
      costUsd: result?.cost.usd,
      costRub: result ? result.cost.usd * settings.billing.usdRubRate : 0,
    });
    return { kind: 'handoff', message, reason };
  };

  // Лимит ответов в одной сессии — дальше менеджер.
  const replies = await d.siteChat.countMessages(session.id, 'agent');
  const all = await d.siteChat.messages(session.id);
  if (replies >= sc.maxRepliesPerSession) {
    return finishHandoff('reply_limit', transcriptSummary(all));
  }

  const siteLead: SiteLeadPort = {
    saveSummary: async (s, opts) => d.siteChat.setSummary(session.id, formatSiteSummary(s), { task: opts.task }),
  };
  // История — всё до текущего сообщения клиента (оно уже записано последним).
  const history = siteHistory(all.filter((m) => !(m.author === 'client' && m.text === incoming && m.id === all.at(-1)?.id)));
  const rules = await d.pricing(session.accountId);
  const ctx: ToolContext = {
    accountId: session.accountId,
    catalog: d.catalog,
    knowledge: d.knowledge,
    crm: new SiteCrm(d.siteChat, session),
    memory: new InMemoryMemory(),
    pricing: rules,
    components: d.components ?? null,
    siteLead,
    tasks: settings.tasks,
  };
  const context = [
    'Клиент пишет из окна чата на сайте rf-dveri.ru. Его имя, телефон и почта уже записаны в заявку — не спрашивайте их.',
    session.pageUrl ? `Страница, с которой написал: ${session.pageUrl}${session.pageTitle ? ` («${session.pageTitle}»)` : ''}.` : null,
  ]
    .filter(Boolean)
    .join(' ');

  let result: TurnResult;
  try {
    result = await ai.orchestrator.runTurn({
      settings,
      history,
      incoming: [incoming],
      ctx,
      tools: SITE_TOOLS,
      now,
      dynamic: { pricing: pricingCodesHint(rules), memory: context, extraRules: { title: 'Правила чата на сайте', text: sc.rules }, channel: 'chat' },
      route: resolveRoute(settings),
    });
  } catch (err) {
    await d.journal.add({ accountId: session.accountId, kind: 'error', summary: `Чат сайта: сбой модели — ${(err as Error).message}`, details: { channel: 'site', sessionId: session.id } });
    return finishHandoff('no_answer', transcriptSummary(all));
  }
  const costRub = result.cost.usd * settings.billing.usdRubRate;

  if (result.kind === 'handoff') return finishHandoff(result.handoff.reason, result.handoff.summary, result);
  if (result.kind === 'blocked') {
    await d.journal.add({ accountId: session.accountId, kind: 'blocked', summary: `Чат сайта: ответ не прошёл проверку — ${result.reason}`, details: { channel: 'site', sessionId: session.id, rejections: result.rejections }, costUsd: result.cost.usd, costRub });
    return finishHandoff('no_answer', transcriptSummary(all), result);
  }

  const products = await productCards(d.catalog, session.accountId, result.sources);
  const message = await d.siteChat.addMessage(session.id, 'agent', result.text, { products, costRub, sync: 'pending' });
  await d.journal.add({
    accountId: session.accountId,
    leadId: session.amoLeadId ?? undefined,
    kind: 'reply',
    summary: result.text,
    details: { channel: 'site', sessionId: session.id, toolCalls: result.toolCalls, sources: result.sources, rejections: result.rejections, provider: result.provider, model: result.model, fallbackUsed: result.fallbackUsed, latencyMs: result.latencyMs, questionTopic: result.questionTopic },
    inputTokens: result.cost.inputTokens,
    outputTokens: result.cost.outputTokens,
    costUsd: result.cost.usd,
    costRub,
  });
  return { kind: 'reply', message };
}

/** Сводка без модели: когда модель недоступна или сломалась — хотя бы переписка в заявке. */
export function transcriptSummary(messages: SiteChatMessage[]): string {
  const lines = messages.filter((m) => m.author !== 'system').slice(-10).map((m) => `${m.author === 'client' ? 'Клиент' : m.author === 'manager' ? 'Менеджер' : 'Амма'}: ${m.text.slice(0, 300)}`);
  return lines.length ? `Переписка:\n${lines.join('\n')}` : 'Клиент не писал в чат.';
}

/**
 * Клиент ушёл (нет сообщений `idleCloseMin`): диалог закрывается, в заявку — сводка, менеджеру — задача
 * «Перезвонить клиенту с сайта». Сводку пишет модель по переписке; без модели — переписка как есть.
 */
export async function closeIdleSession(d: SiteTurnDeps, session: SiteChatSession, settings: WidgetSettings): Promise<'closed' | 'skipped'> {
  if (session.state !== 'active') return 'skipped';
  const messages = await d.siteChat.messages(session.id);
  const history = siteHistory(messages);
  if (!history.some((m) => m.role === 'client')) return 'skipped';
  await d.siteChat.setState(session.id, 'closed');
  if (session.summaryText) {
    await d.siteChat.requestTask(session.id);
    return 'closed';
  }
  let text = transcriptSummary(messages);
  const ai = await d.ai(session.accountId).catch(() => null);
  if (ai && history.some((m) => m.role === 'ai')) {
    try {
      const s = await summarizeDialog(ai.llm, settings, { history, route: resolveRoute(settings) });
      if (s.text) text = s.text;
      await d.journal.add({
        accountId: session.accountId,
        leadId: session.amoLeadId ?? undefined,
        kind: 'summary',
        summary: `Чат сайта: сводка при закрытии диалога`,
        details: { channel: 'site', sessionId: session.id, provider: s.provider, model: s.model },
        inputTokens: s.cost.inputTokens,
        outputTokens: s.cost.outputTokens,
        costUsd: s.cost.usd,
        costRub: s.cost.usd * settings.billing.usdRubRate,
      });
    } catch (err) {
      await d.journal.add({ accountId: session.accountId, kind: 'error', summary: `Чат сайта: сводка не составлена — ${(err as Error).message}`, details: { channel: 'site', sessionId: session.id } });
    }
  }
  await d.siteChat.setSummary(session.id, `Сводка Аммы (чат сайта)\n${text}`, { task: true });
  return 'closed';
}
