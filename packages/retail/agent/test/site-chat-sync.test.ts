import { JournalRepo, SettingsRepo, SiteChatRepo, widgetSettingsSchema } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seeded, type Seeded } from '../../../core/tools/test/fixtures.ts';
import { firstNoteText, groupForNotes, leadName, runSiteChatSync, type SiteSyncApi, type SiteSyncDeps } from '../src/site-chat-sync.ts';

const ACC = 1;
let s: Seeded;
let repo: SiteChatRepo;
let journal: JournalRepo;
let settingsRepo: SettingsRepo;
// «Сейчас» — реальное время: срок следующей попытки в базе ставится её часами (now()).
const NOW = new Date();

beforeAll(async () => {
  s = await seeded(ACC);
  repo = new SiteChatRepo(s.db);
  journal = new JournalRepo(s.db);
  settingsRepo = new SettingsRepo(s.db);
  await settingsRepo.save(ACC, 1, widgetSettingsSchema.parse({ enabled: true, siteChat: { enabled: true }, handoff: { fallbackUserId: 9 } }));
});
afterAll(async () => s.drop());

/** Подделка amo: запоминает вызовы, умеет падать. */
function fakeApi(opts: { contactsByPhone?: { id: number }[]; contactsByEmail?: { id: number }[]; failUnsorted?: boolean; failNotes?: boolean } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  let noteSeq = 100;
  const api = {
    domain: 'acc.amocrm.ru',
    async findContactsByPhone() {
      return (opts.contactsByPhone ?? []) as never;
    },
    async findContactsByEmail() {
      return (opts.contactsByEmail ?? []) as never;
    },
    async createUnsortedForm(a: unknown) {
      calls.push({ method: 'createUnsortedForm', args: [a] });
      if (opts.failUnsorted) throw new Error('HTTP 500');
      return { uid: 'u-1', leadId: 500, contactId: 77 };
    },
    async addContactFields(id: number, a: unknown) {
      calls.push({ method: 'addContactFields', args: [id, a] });
      return true;
    },
    async addLeadNote(leadId: number, text: string) {
      calls.push({ method: 'addLeadNote', args: [leadId, text] });
      if (opts.failNotes) throw new Error('notes 502');
      return ++noteSeq;
    },
    async updateLeadNote(leadId: number, noteId: number, text: string) {
      calls.push({ method: 'updateLeadNote', args: [leadId, noteId, text] });
    },
    async createTask(t: unknown) {
      calls.push({ method: 'createTask', args: [t] });
      return 42;
    },
    async getLead() {
      return { responsible_user_id: 0 } as never;
    },
    async listUsers() {
      return [{ id: 9, name: 'Админ', email: null, isActive: true, isAdmin: true }] as never;
    },
  } satisfies SiteSyncApi;
  return { api, calls };
}

function deps(api: SiteSyncApi, now?: Date): SiteSyncDeps {
  return { siteChat: repo, settings: settingsRepo, journal, amo: async () => ({ api }), now: () => now ?? new Date() };
}

async function session(phone: string, text: string, state: 'active' | 'spam' = 'active') {
  const sess = await repo.create({ accountId: ACC, name: 'Павел', phone, email: 'p@example.com', consentAt: NOW, pageUrl: 'https://www.rf-dveri.ru/catalog/', pageTitle: 'Каталог', referrer: 'https://yandex.ru/', utm: { utm_source: 'yandex' }, ymUid: '555', ip: '1.2.3.4', state });
  const first = await repo.addMessage(sess.id, 'client', text);
  return { sess, first };
}

describe('тексты', () => {
  it('название заявки и первое примечание', async () => {
    const long = leadName({ name: 'Павел' }, 'дверь-книжка 340+340, высота 2000, Дуб Сонома, и ещё много-много текста, который не влезет в название');
    expect(long.startsWith('Чат с сайта: Павел — дверь-книжка 340+340')).toBe(true);
    expect(long.length).toBe('Чат с сайта: Павел — '.length + 60);
    expect(leadName({ name: 'Анна' }, '  короткий   текст ')).toBe('Чат с сайта: Анна — короткий текст');
    // Спам — чтобы эта сессия не попала в очередь синхронизации в тестах ниже.
    const { sess } = await session('79990000001', 'привет', 'spam');
    const note = firstNoteText(sess, 'привет');
    expect(note.split('\n')[0]).toBe('Сообщение с сайта:');
    expect(note).toContain('Страница: https://www.rf-dveri.ru/catalog/ («Каталог»)');
    expect(note).toContain('UTM: utm_source=yandex');
    expect(note).toContain('ClientID Метрики: 555');
  });

  it('группировка примечаний: пары «вопрос → ответ», хвост без ответа — только после паузы или закрытия', () => {
    const m = (id: number, author: 'client' | 'agent', minsAgo: number) => ({ id, author, createdAt: new Date(NOW.getTime() - minsAgo * 60_000), text: String(id), sessionId: 's', products: [], costRub: 0, amoNoteId: null, amoSync: 'pending' as const });
    const groups = groupForNotes([m(1, 'client', 10), m(2, 'client', 9), m(3, 'agent', 8), m(4, 'client', 1)], { state: 'active' }, NOW);
    expect(groups.map((g) => g.map((x) => x.id))).toEqual([[1, 2, 3]]);
    expect(groupForNotes([m(4, 'client', 3)], { state: 'active' }, NOW).map((g) => g.map((x) => x.id))).toEqual([[4]]);
    expect(groupForNotes([m(4, 'client', 1)], { state: 'closed' }, NOW).map((g) => g.map((x) => x.id))).toEqual([[4]]);
  });
});

describe('runSiteChatSync', () => {
  it('новый клиент: заявка с новым контактом, первое примечание, пара вопрос→ответ, сводка, задача администратору', async () => {
    const { sess } = await session('79990000002', 'нужна дверь');
    await repo.addMessage(sess.id, 'agent', 'Какая?');
    await repo.setSummary(sess.id, 'Сводка Аммы (чат сайта)\nЧто ищет: дверь', { task: true });
    await repo.setState(sess.id, 'handed_off', 'client_request');
    const { api, calls } = fakeApi();
    const r = await runSiteChatSync(deps(api));
    expect(r).toMatchObject({ leads: 1, notes: 2, summaries: 1, tasks: 1, errors: 0 });
    const form = calls.find((c) => c.method === 'createUnsortedForm')!.args[0] as Record<string, unknown>;
    expect(form).toMatchObject({ sourceUid: 'site-chat', pipelineId: 1873498, tag: 'Чат сайта', leadName: 'Чат с сайта: Павел — нужна дверь', contact: { name: 'Павел', phone: '79990000002', email: 'p@example.com' } });
    expect((form.metadata as { formPage: string; ip: string }).formPage).toBe('https://www.rf-dveri.ru/catalog/');
    const notes = calls.filter((c) => c.method === 'addLeadNote').map((c) => c.args[1] as string);
    expect(notes[0]).toMatch(/^Сообщение с сайта:\nнужна дверь/);
    // Первое сообщение клиента ушло отдельным примечанием, поэтому пара здесь — только ответ агента.
    expect(notes[1]).toMatch(/^Чат сайта\n\[\d\d:\d\d\] Амма: Какая\?$/);
    expect(notes[2]).toContain('Сводка Аммы');
    const task = calls.find((c) => c.method === 'createTask')!.args[0] as { text: string; responsibleUserId?: number; leadId: number };
    expect(task.leadId).toBe(500);
    expect(task.text).toContain('Перезвонить клиенту с сайта: Павел, +79990000002 (просит менеджера)');
    expect(task.responsibleUserId).toBe(9);
    const got = await repo.get(sess.id);
    expect(got).toMatchObject({ amoSync: 'sent', amoLeadId: 500, amoContactId: 77, summarySync: 'sent', taskSync: 'sent', taskId: 42 });
    expect((await repo.messages(sess.id)).every((m) => m.amoSync === 'sent')).toBe(true);
    // Повторный проход ничего не шлёт.
    expect((await runSiteChatSync(deps(api))).sessions).toBe(0);
  });

  it('контакт уже есть по телефону: заявка привязана к нему, новая почта дописана, нового контакта нет', async () => {
    const { sess } = await session('79990000003', 'второй раз');
    const { api, calls } = fakeApi({ contactsByPhone: [{ id: 321 }] });
    await runSiteChatSync(deps(api));
    const form = calls.find((c) => c.method === 'createUnsortedForm')!.args[0] as { contact: unknown };
    expect(form.contact).toEqual({ id: 321 });
    expect(calls.find((c) => c.method === 'addContactFields')?.args).toEqual([321, { phone: '79990000003', email: 'p@example.com' }]);
    expect(await repo.get(sess.id)).toMatchObject({ amoContactId: 321, amoLeadId: 500 });
  });

  it('amoCRM недоступна: повторы по расписанию, после 4 неудач — failed и запись в журнал; восстановилась — заявка уходит', async () => {
    const { sess } = await session('79990000004', 'упадёт');
    const broken = fakeApi({ failUnsorted: true });
    let t: Date | undefined;
    for (let i = 1; i <= 4; i++) {
      const r = await runSiteChatSync(deps(broken.api, t));
      expect(r.errors).toBe(1);
      const got = (await repo.get(sess.id))!;
      expect(got.amoAttempts).toBe(i);
      t = new Date(got.amoNextTryAt.getTime() + 1000);
    }
    expect(await repo.get(sess.id)).toMatchObject({ amoSync: 'failed', amoAttempts: 4 });
    const log = await journal.list(ACC, { kind: 'error', limit: 5 });
    expect(log[0]?.summary).toContain('после 4 попыток');
    expect(log[0]?.details).toMatchObject({ channel: 'site', sessionId: sess.id, stage: 'lead' });
    // failed больше в очередь не попадает.
    expect((await runSiteChatSync(deps(fakeApi().api, t))).sessions).toBe(0);

    // Другая сессия: первая попытка упала, вторая прошла.
    const { sess: s2 } = await session('79990000005', 'восстановится');
    await runSiteChatSync(deps(fakeApi({ failUnsorted: true }).api));
    const ok = fakeApi();
    await runSiteChatSync(deps(ok.api, new Date(Date.now() + 2 * 60_000)));
    expect(await repo.get(s2.id)).toMatchObject({ amoSync: 'sent', amoAttempts: 0, amoError: null });
    expect(ok.calls.some((c) => c.method === 'addLeadNote')).toBe(true);
  });

  it('заявка создана, примечание не записалось — сообщение остаётся pending и уходит следующим проходом', async () => {
    const { sess } = await session('79990000006', 'примечание упадёт');
    await runSiteChatSync(deps(fakeApi({ failNotes: true }).api));
    let got = (await repo.get(sess.id))!;
    expect(got).toMatchObject({ amoSync: 'sent', amoLeadId: 500, amoAttempts: 1 });
    expect((await repo.messages(sess.id))[0]?.amoSync).toBe('pending');
    const ok = fakeApi();
    await runSiteChatSync(deps(ok.api, new Date(got.amoNextTryAt.getTime() + 1000)));
    expect((await repo.messages(sess.id))[0]?.amoSync).toBe('sent');
    expect(ok.calls.filter((c) => c.method === 'createUnsortedForm')).toHaveLength(0);
    got = (await repo.get(sess.id))!;
    expect(got.amoLeadId).toBe(500);
  });
});
