import { JournalRepo, SettingsRepo, SiteChatRepo, widgetSettingsSchema, type WidgetSettingsInput } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seeded, type Seeded } from '../../../core/tools/test/fixtures.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import type { AccountAi } from '../src/provider.ts';
import { closeIdleSession, handoffText, mentionedProducts, runSiteTurn, siteHistory, withinHours, type SiteTurnDeps } from '../src/site-chat.ts';
import { ScriptedLlm, text, toolUse } from './scripted-llm.ts';

const ACC = 1;
let s: Seeded;
let repo: SiteChatRepo;
let journal: JournalRepo;
let settingsRepo: SettingsRepo;

beforeAll(async () => {
  s = await seeded(ACC);
  repo = new SiteChatRepo(s.db);
  journal = new JournalRepo(s.db);
  settingsRepo = new SettingsRepo(s.db);
});
afterAll(async () => s.drop());

async function saveSettings(siteChat: Record<string, unknown> = {}, rest: WidgetSettingsInput = {}) {
  await settingsRepo.save(ACC, 1, widgetSettingsSchema.parse({ enabled: true, mode: 'auto', siteChat: { enabled: true, ...siteChat }, ...rest }));
}

function deps(llm: ScriptedLlm | null, now = new Date('2026-11-19T10:00:00Z')): SiteTurnDeps {
  return {
    ai: async () => (llm ? ({ llm, orchestrator: new Orchestrator(llm), source: 'account', providers: ['anthropic'], keySource: {} } as unknown as AccountAi) : null),
    settings: settingsRepo,
    journal,
    siteChat: repo,
    catalog: s.catalog,
    knowledge: s.knowledge,
    pricing: async () => null,
    now: () => now,
  };
}

async function session(phone = '79261234567') {
  const sess = await repo.create({ accountId: ACC, name: 'Павел', phone, email: 'p@example.com', consentAt: new Date(), pageUrl: 'https://www.rf-dveri.ru/catalog/', pageTitle: 'Каталог' });
  return sess;
}

describe('вспомогательные', () => {
  it('часы ответов по Москве и телефон в фразе передачи', () => {
    const at = (iso: string) => new Date(iso);
    expect(withinHours(null, null, at('2026-11-19T01:00:00Z'))).toBe(true);
    expect(withinHours('10:00', '20:00', at('2026-11-19T08:00:00Z'))).toBe(true); // 11:00 МСК
    expect(withinHours('10:00', '20:00', at('2026-11-19T18:30:00Z'))).toBe(false); // 21:30 МСК
    expect(withinHours('22:00', '06:00', at('2026-11-19T22:00:00Z'))).toBe(true); // 01:00 МСК, через полночь
    expect(handoffText('Передала менеджеру, он перезвонит на {phone}.', '79261234567')).toBe('Передала менеджеру, он перезвонит на +7 926 123-45-67.');
  });
});

describe('карточки товаров', () => {
  it('только названные в ответе: защёлки из выдачи поиска без упоминания не показываются; полное имя и модель с номером', () => {
    const src = [
      { type: 'product' as const, id: 'z1', title: 'Защёлка магнитная' },
      { type: 'product' as const, id: 'z2', title: 'Защёлка сантехническая' },
      { type: 'product' as const, id: '1001', title: 'Турин 1 эмаль белая' },
      { type: 'product' as const, id: '1002', title: 'Турин 2 эмаль белая' },
      { type: 'product' as const, id: '77', title: 'Скин-5 ПГ (Белая эмаль)' },
    ];
    expect(mentionedProducts('Подойдёт Турин 1 эмаль белая — 14 900 ₽. Ещё есть Скин-5 ПГ белая эмаль.', src)).toEqual(['1001', '77']);
    expect(mentionedProducts('Белые двери есть, уточните размер.', src)).toEqual([]);
    expect(mentionedProducts('Турин 2 — 15 900 ₽', src)).toEqual(['1002']);
  });
});

describe('runSiteTurn — канал site', () => {
  it('ответ с карточкой товара: инструменты только SITE_TOOLS, правила канала и контекст без контактов в промпте, журнал с каналом', async () => {
    await saveSettings();
    const sess = await session();
    await repo.addMessage(sess.id, 'client', 'Нужна белая дверь эмаль');
    const llm = new ScriptedLlm([
      toolUse(['catalog_search', { query: 'белая дверь эмаль' }]),
      text('Подойдёт Турин 1 эмаль белая — 14 900 ₽, в наличии: https://rf-dveri.ru/catalog/test-1001/. Сколько дверей нужно? [Q: kolichestvo]'),
    ]);
    const out = await runSiteTurn(deps(llm), sess.id, 'Нужна белая дверь эмаль');
    expect(out.kind).toBe('reply');
    if (out.kind !== 'reply') throw new Error('x');
    expect(out.message.author).toBe('agent');
    expect(out.message.text).toContain('Турин 1');
    expect(out.message.text).not.toContain('[Q:');
    expect(out.message.products.length).toBeLessThanOrEqual(3);
    expect(out.message.products.find((p) => p.id === '1001')).toMatchObject({ price: 14900, url: 'https://rf-dveri.ru/catalog/test-1001/' });
    expect(out.message.costRub).toBeGreaterThan(0);
    const req = llm.requests[0]!;
    const names = (req.tools ?? []).map((t) => (t as { name: string }).name);
    expect(names).toEqual(['catalog_search', 'catalog_get_product', 'door_components', 'knowledge_search', 'price_calculate', 'site_lead_summary', 'crm_handoff']);
    const system = JSON.stringify(req.system);
    expect(system).toContain('Правила чата на сайте');
    expect(system).toContain('не спрашивайте их');
    expect(system).not.toContain('79261234567');
    expect(system).not.toContain('p@example.com');
    expect(system).not.toContain('Павел');
    const log = await journal.list(ACC, { limit: 5 });
    expect(log[0]).toMatchObject({ kind: 'reply', details: expect.objectContaining({ channel: 'site', sessionId: sess.id }) });
    expect(Number(log[0]?.costRub)).toBeGreaterThan(0);
    // История следующего хода: клиент → агент, системных нет.
    const msgs = await repo.messages(sess.id);
    expect(siteHistory(msgs).map((m) => m.role)).toEqual(['client', 'ai']);
  });

  it('сводка через site_lead_summary и передача менеджеру: состояние, сводка, задача, фраза с телефоном; после — только «дописала в заявку»', async () => {
    await saveSettings();
    const sess = await session('79990000011');
    await repo.addMessage(sess.id, 'client', 'Позовите человека, хочу дверь-книжку 340+340');
    const llm = new ScriptedLlm([
      toolUse(
        ['site_lead_summary', { need: 'дверь-книжка 340+340', sizes: '340+340, высота 2000', quantity: '1', task: true }],
        ['crm_handoff', { reason: 'client_request', summary: 'Просит человека; дверь-книжка 340+340' }],
      ),
    ]);
    const out = await runSiteTurn(deps(llm), sess.id, 'Позовите человека, хочу дверь-книжку 340+340');
    expect(out).toMatchObject({ kind: 'handoff', reason: 'client_request' });
    if (out.kind !== 'handoff') throw new Error('x');
    expect(out.message.text).toBe('Передала менеджеру, он перезвонит на +7 999 000-00-11.');
    const got = await repo.get(sess.id);
    expect(got).toMatchObject({ state: 'handed_off', handoffReason: 'client_request', summarySync: 'pending', taskSync: 'pending' });
    expect(got?.summaryText).toContain('Что ищет: дверь-книжка 340+340');
    expect(got?.summaryText).toContain('Размеры: 340+340, высота 2000');
    // Следующее сообщение после передачи: без модели.
    await repo.addMessage(sess.id, 'client', 'а ещё цвет дуб');
    const after = await runSiteTurn(deps(new ScriptedLlm([])), sess.id, 'а ещё цвет дуб');
    expect(after).toMatchObject({ kind: 'auto', why: 'after_handoff' });
    if (after.kind !== 'auto') throw new Error('x');
    expect(after.message).toMatchObject({ author: 'system', text: 'Дописала в заявку, менеджер увидит.' });
  });

  it('передача без сводки от модели — сводка из summary передачи; сбой модели — передача с перепиской', async () => {
    await saveSettings();
    const sess = await session('79990000012');
    await repo.addMessage(sess.id, 'client', 'Жалоба на монтаж');
    const llm = new ScriptedLlm([toolUse(['crm_handoff', { reason: 'complaint', summary: 'Недоволен монтажом, просит перезвонить' }])]);
    const out = await runSiteTurn(deps(llm), sess.id, 'Жалоба на монтаж');
    expect(out.kind).toBe('handoff');
    expect((await repo.get(sess.id))?.summaryText).toContain('Недоволен монтажом');

    const sess2 = await session('79990000013');
    await repo.addMessage(sess2.id, 'client', 'привет');
    const broken = new ScriptedLlm([new Error('overloaded')]);
    const out2 = await runSiteTurn(deps(broken), sess2.id, 'привет');
    expect(out2).toMatchObject({ kind: 'handoff', reason: 'no_answer' });
    expect((await repo.get(sess2.id))?.summaryText).toContain('Клиент: привет');
  });

  it('автоответы: агент выключен, вне часов, бюджет исчерпан, нет ключа; чат выключен — ничего', async () => {
    await saveSettings({ agentEnabled: false });
    const sess = await session('79990000014');
    await repo.addMessage(sess.id, 'client', 'ау');
    let out = await runSiteTurn(deps(new ScriptedLlm([])), sess.id, 'ау');
    expect(out).toMatchObject({ kind: 'auto', why: 'agent_off' });
    if (out.kind !== 'auto') throw new Error('x');
    expect(out.message).toMatchObject({ author: 'system', text: 'Спасибо! Менеджер перезвонит в течение 15 минут.', amoSync: 'skipped' });

    await saveSettings({ hoursFrom: '10:00', hoursTo: '20:00', offHoursText: 'Ночь, перезвоним утром.' });
    out = await runSiteTurn(deps(new ScriptedLlm([]), new Date('2026-11-19T20:00:00Z')), sess.id, 'ау'); // 23:00 МСК
    expect(out).toMatchObject({ kind: 'auto', why: 'off_hours' });

    await saveSettings({ dailyBudgetRub: 0.01 });
    const rich = await session('79990000015');
    await repo.addMessage(rich.id, 'agent', 'дорогой ответ', { costRub: 5 });
    await repo.addMessage(rich.id, 'client', 'ещё');
    // Расход считается за «сегодня» по часам базы (created_at = now()) — «сейчас» должно быть реальным, не 19.11.
    out = await runSiteTurn(deps(new ScriptedLlm([]), new Date()), rich.id, 'ещё');
    expect(out).toMatchObject({ kind: 'auto', why: 'budget' });

    await saveSettings();
    out = await runSiteTurn(deps(null), sess.id, 'ау');
    expect(out).toMatchObject({ kind: 'auto', why: 'no_llm' });

    await saveSettings({ enabled: false });
    out = await runSiteTurn(deps(new ScriptedLlm([])), sess.id, 'ау');
    expect(out).toEqual({ kind: 'skipped', why: 'site_off' });
  });

  it('лимит ответов в сессии → передача менеджеру без вызова модели', async () => {
    await saveSettings({ maxRepliesPerSession: 2 });
    const sess = await session('79990000016');
    await repo.addMessage(sess.id, 'client', '1');
    await repo.addMessage(sess.id, 'agent', 'a');
    await repo.addMessage(sess.id, 'client', '2');
    await repo.addMessage(sess.id, 'agent', 'b');
    await repo.addMessage(sess.id, 'client', '3');
    const llm = new ScriptedLlm([]);
    const out = await runSiteTurn(deps(llm), sess.id, '3');
    expect(out).toMatchObject({ kind: 'handoff', reason: 'reply_limit' });
    expect(llm.requests).toHaveLength(0);
    expect((await repo.get(sess.id))?.taskSync).toBe('pending');
  });
});

describe('closeIdleSession', () => {
  it('клиент ушёл: диалог закрыт, сводка от модели, задача; без переписки — пропуск', async () => {
    await saveSettings();
    const sess = await session('79990000017');
    await repo.addMessage(sess.id, 'client', 'ищу дверь');
    await repo.addMessage(sess.id, 'agent', 'какую?');
    const llm = new ScriptedLlm([text('Клиент ищет дверь, деталей не назвал.')]);
    const { settings } = await settingsRepo.get(ACC);
    expect(await closeIdleSession(deps(llm), (await repo.get(sess.id))!, settings)).toBe('closed');
    const got = await repo.get(sess.id);
    expect(got).toMatchObject({ state: 'closed', summarySync: 'pending', taskSync: 'pending' });
    expect(got?.summaryText).toContain('Клиент ищет дверь');
    expect(await closeIdleSession(deps(llm), got!, settings)).toBe('skipped');

    const empty = await session('79990000018');
    expect(await closeIdleSession(deps(llm), empty, settings)).toBe('skipped');
  });
});
