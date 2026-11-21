import { readFileSync } from 'node:fs';
import { widgetSettingsSchema } from '@core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedLlm, text, toolUse } from '../../../packages/retail/agent/test/scripted-llm.ts';
import type { SiteEvent } from '../src/site-chat/service.ts';
import { setup } from './helpers.ts';

const ACC = 31337;
const steps: ConstructorParameters<typeof ScriptedLlm>[0] = [];
let ctx: Awaited<ReturnType<typeof setup>>;

const form = (over: Record<string, unknown> = {}) => ({
  name: 'Павел',
  phone: '8 (926) 123-45-67',
  email: 'pavel@example.com',
  message: 'дверь-книжка 340+340, высота 2000, Дуб Сонома',
  consent: true,
  opened_at: Date.now() - 10_000,
  page_url: 'https://www.rf-dveri.ru/catalog/knizhka/',
  page_title: 'Двери-книжки',
  referrer: 'https://yandex.ru/',
  utm: { utm_source: 'yandex', utm_medium: 'cpc', junk: 'x' },
  ym_uid: '123',
  yclid: 'ycl-42',
  ...over,
});

async function enable(siteChat: Record<string, unknown> = {}) {
  const { settings } = await ctx.deps.settings.get(ACC);
  await ctx.deps.settings.save(ACC, 1, widgetSettingsSchema.parse({ ...settings, enabled: true, mode: 'auto', siteChat: { ...settings.siteChat, enabled: true, ...siteChat } }));
}

const post = (url: string, payload: Record<string, unknown>, remoteAddress = '10.1.1.1', origin = 'https://www.rf-dveri.ru') =>
  ctx.app.inject({ method: 'POST', url, payload, remoteAddress, headers: { origin } });

beforeAll(async () => {
  ctx = await setup({ llm: new ScriptedLlm(steps) });
  await ctx.deps.accounts.upsertInstalled({ id: ACC, subdomain: 'aleksnevedrov', accountDomain: 'aleksnevedrov.amocrm.ru' });
  await ctx.deps.importer.importFromBytes(ACC, new Uint8Array(readFileSync(new URL('../../../evals/fixtures/catalog.yml', import.meta.url))));
});
afterAll(async () => ctx.close());

describe('чат сайта: config, health, CORS, демо', () => {
  it('выключен → enabled:false и 503 на форму; включён → тексты и всплывание без секретов', async () => {
    expect((await ctx.app.inject({ url: '/site-chat/v1/config' })).json()).toEqual({ enabled: false });
    expect((await post('/site-chat/v1/session', form())).statusCode).toBe(503);
    await enable({ popup: { enabled: true, delaySec: 15, text: 'Подскажу по дверям', pages: ['/catalog/'], mobile: false }, privacyUrl: 'https://www.rf-dveri.ru/policy/', contacts: { whatsapp: 'https://wa.me/74955324941', telegram: 'https://t.me/rfdveri', max: '', email: 'info@rf-dveri.ru' } });
    const cfg = (await ctx.app.inject({ url: '/site-chat/v1/config' })).json();
    expect(cfg).toMatchObject({ enabled: true, online: true, popup: { enabled: true, delaySec: 15, pages: ['/catalog/'] }, privacyUrl: 'https://www.rf-dveri.ru/policy/', contacts: { whatsapp: 'https://wa.me/74955324941', telegram: 'https://t.me/rfdveri', max: '', email: 'info@rf-dveri.ru' } });
    expect(cfg.texts.greeting).toContain('Амма');
    expect(JSON.stringify(cfg)).not.toMatch(/sk-|token|secret/i);
    expect((await ctx.app.inject({ url: '/site-chat/v1/health' })).json()).toMatchObject({ status: 'ok', enabled: true, accountId: ACC });
    const demo = await ctx.app.inject({ url: '/site-chat/demo' });
    expect(demo.statusCode).toBe(200);
    expect(demo.body).toContain('/site-chat/widget.js');
  });

  it('иконки шторки «Связаться с нами» отдаются только по белому списку имён', async () => {
    const ok = await ctx.app.inject({ url: '/site-chat/assets/whatsapp.svg' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('image/svg+xml');
    expect((await ctx.app.inject({ url: '/site-chat/assets/max.png' })).headers['content-type']).toContain('image/png');
    expect((await ctx.app.inject({ url: '/site-chat/assets/..%2Fwidget.js' })).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: '/site-chat/assets/nope.svg' })).statusCode).toBe(404);
  });

  it('CORS: домены сайта разрешены, чужой — нет', async () => {
    const ok = await ctx.app.inject({ method: 'OPTIONS', url: '/site-chat/v1/session', headers: { origin: 'https://rf-dveri.ru', 'access-control-request-method': 'POST' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://rf-dveri.ru');
    const bad = await ctx.app.inject({ method: 'OPTIONS', url: '/site-chat/v1/session', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('чат сайта: форма → сессия → ответ агента', () => {
  it('невалидная форма — 400 с полем; без согласия — 400; ловушка — 200 и ничего не создано', async () => {
    const r = await post('/site-chat/v1/session', form({ phone: '12345' }));
    expect(r.statusCode).toBe(400);
    expect(r.json().issues[0]).toMatchObject({ path: 'phone' });
    expect((await post('/site-chat/v1/session', form({ consent: false }))).statusCode).toBe(400);
    const trap = await post('/site-chat/v1/session', form({ website: 'http://spam' }));
    expect(trap.statusCode).toBe(200);
    expect((await ctx.deps.siteChat.list(ACC)).length).toBe(0);
  });

  it('заявка создаётся сразу (строка pending для amoCRM), телефон нормализован, UTM отфильтрованы; агент отвечает в фоне с карточкой', async () => {
    steps.push(toolUse(['catalog_search', { query: 'белая дверь эмаль' }]), text('Подойдёт Турин 1 эмаль белая — 14 900 ₽: https://rf-dveri.ru/catalog/test-1001/. Сколько дверей? [Q: kolichestvo]'));
    const events: SiteEvent[] = [];
    const r = await post('/site-chat/v1/session', form());
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.session).toMatch(/^[0-9a-f]{32}$/);
    expect(body.duplicate).toBe(false);
    expect(body.messages.map((m: { author: string }) => m.author)).toEqual(['client', 'agent']);
    expect(body.messages[1].text).toContain('Амма');
    const off = ctx.app.siteChatService.subscribe(body.session, (e) => events.push(e));
    const s = await ctx.deps.siteChat.get(body.session);
    expect(s).toMatchObject({ phone: '79261234567', email: 'pavel@example.com', name: 'Павел', state: 'active', amoSync: 'pending', utm: { utm_source: 'yandex', utm_medium: 'cpc' }, ymUid: '123', yclid: 'ycl-42', ip: '10.1.1.1', pageTitle: 'Двери-книжки' });
    await ctx.app.siteChatService.idle();
    off();
    const list = (await ctx.app.inject({ url: `/site-chat/v1/messages?session=${body.session}&after=0` })).json();
    expect(list.state).toBe('active');
    expect(list.messages.map((m: { author: string }) => m.author)).toEqual(['client', 'agent', 'agent']);
    expect(list.messages[2].text).toContain('Турин 1');
    expect(list.messages[2].text).not.toContain('[Q:');
    expect(list.messages[2].products.some((p: { id: string }) => p.id === '1001')).toBe(true);
    expect(events.find((e) => e.type === 'message')).toMatchObject({ message: { author: 'agent' } });
    expect(events.at(-1)).toEqual({ type: 'typing', on: false });
    const log = await ctx.deps.journal.list(ACC, { limit: 3 });
    expect(log[0]).toMatchObject({ kind: 'reply', details: expect.objectContaining({ channel: 'site', sessionId: body.session }) });
    // Повтор той же формы за 10 минут — та же сессия, вторая заявка не создаётся.
    const again = await post('/site-chat/v1/session', form());
    expect(again.json()).toMatchObject({ session: body.session, duplicate: true });
    expect(again.json().messages.length).toBe(3);
  });

  it('сообщение: ответ агента, защита от флуда (3 с), 404 для чужого session_id', async () => {
    const sess = (await ctx.deps.siteChat.list(ACC))[0]!;
    const fast = await post('/site-chat/v1/message', { session: sess.id, text: 'две' });
    expect(fast.statusCode).toBe(429); // форма была только что
    await ctx.deps.db.query(`UPDATE site_chat_messages SET created_at = created_at - interval '10 seconds' WHERE session_id = $1`, [sess.id]);
    // Цена проходит пост-фильтр только из результата инструмента этого хода.
    steps.push(toolUse(['catalog_get_product', { id: '1001' }]), text('Две двери Турин 1 — по 14 900 ₽ каждая. Нужна ли установка? [Q: none]'));
    const ok = await post('/site-chat/v1/message', { session: sess.id, text: 'две' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().message).toMatchObject({ author: 'client', text: 'две' });
    await ctx.app.siteChatService.idle();
    const after = (await ctx.app.inject({ url: `/site-chat/v1/messages?session=${sess.id}&after=${ok.json().message.id}` })).json();
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]).toMatchObject({ author: 'agent' });
    expect(after.messages[0].text).toContain('Две двери');
    expect((await post('/site-chat/v1/message', { session: 'a'.repeat(32), text: 'x' })).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: `/site-chat/v1/messages?session=${'a'.repeat(32)}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: `/site-chat/v1/messages?session=bad` })).statusCode).toBe(400);
  });

  it('форма быстрее 3 секунд — спам: в базе state spam, заявки и ответа агента нет, окно получает обычный ответ', async () => {
    const r = await post('/site-chat/v1/session', form({ phone: '+7 999 111-22-33', message: 'ааа', opened_at: Date.now() - 500 }), '10.1.1.2');
    expect(r.statusCode).toBe(200);
    expect(r.json().state).toBe('active');
    expect(r.json().messages.map((m: { author: string }) => m.author)).toEqual(['client']);
    const s = await ctx.deps.siteChat.get(r.json().session);
    expect(s).toMatchObject({ state: 'spam', amoSync: 'failed' });
    await ctx.app.siteChatService.idle();
    expect(await ctx.deps.siteChat.countMessages(s!.id)).toBe(1);
    // Сообщение в спам-сессию принимается молча и не хранится.
    expect((await post('/site-chat/v1/message', { session: s!.id, text: 'ещё' })).statusCode).toBe(200);
    expect(await ctx.deps.siteChat.countMessages(s!.id)).toBe(1);
    expect((await ctx.app.inject({ url: `/site-chat/v1/messages?session=${s!.id}` })).statusCode).toBe(404);
  });

  it('не более 3 новых сессий с одного IP за 10 минут', async () => {
    for (let i = 0; i < 3; i++) {
      steps.push(text(`ок ${i} [Q: none]`));
      const r = await post('/site-chat/v1/session', form({ phone: `+7 999 000-00-${10 + i}`, message: `вопрос ${i}` }), '10.1.1.3');
      expect(r.statusCode).toBe(200);
    }
    const fourth = await post('/site-chat/v1/session', form({ phone: '+7 999 000-00-99', message: 'четвёртая' }), '10.1.1.3');
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json()).toEqual({ error: 'too_many_sessions' });
    await ctx.app.siteChatService.idle();
  });

  it('заказ звонка со шторки: заявка с телефоном без почты, сессия handed_off (callback), задача ждёт записи, агент не вызывается; повтор — дубль', async () => {
    const body = { phone: '+7 (926) 555-66-77', consent: true, opened_at: Date.now() - 10_000, page_url: 'https://www.rf-dveri.ru/catalog/skin-5/', utm: { utm_source: 'yandex' } };
    const r = await post('/site-chat/v1/callback', body, '10.1.1.5');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, duplicate: false });
    const s = (await ctx.deps.siteChat.list(ACC)).find((x) => x.phone === '79265556677');
    expect(s).toMatchObject({ name: 'Заказ звонка с сайта', email: '', state: 'handed_off', handoffReason: 'callback', amoSync: 'pending', taskSync: 'pending', utm: { utm_source: 'yandex' } });
    await ctx.app.siteChatService.idle();
    const msgs = await ctx.deps.siteChat.messages(s!.id);
    expect(msgs.map((m) => [m.author, m.text])).toEqual([['client', 'Заказать звонок']]);
    expect((await post('/site-chat/v1/callback', body, '10.1.1.5')).json()).toEqual({ ok: true, duplicate: true });
    expect((await post('/site-chat/v1/callback', { ...body, phone: '123' }, '10.1.1.5')).statusCode).toBe(400);
    expect((await post('/site-chat/v1/callback', { ...body, consent: false }, '10.1.1.5')).statusCode).toBe(400);
    expect((await post('/site-chat/v1/callback', { ...body, phone: '+7 926 000-11-22', website: 'spam' }, '10.1.1.5')).json()).toEqual({ ok: true, duplicate: false });
    expect((await ctx.deps.siteChat.list(ACC)).find((x) => x.phone === '79260001122')).toBeUndefined();
  });

  it('ответ менеджера из базы виден в истории с именем, опрос истории отмечает «окно на связи» (seen_at)', async () => {
    const sess = (await ctx.deps.siteChat.list(ACC)).find((x) => x.state === 'active' && x.email)!;
    expect(sess.seenAt === null || sess.seenAt instanceof Date).toBe(true);
    const m = await ctx.deps.siteChat.addMessage(sess.id, 'manager', 'Да, делаем 2100', { sync: 'skipped', authorName: 'Иван Петров', amoNoteId: 7001 });
    const list = (await ctx.app.inject({ url: `/site-chat/v1/messages?session=${sess.id}&after=${m.id - 1}` })).json();
    expect(list.messages).toEqual([expect.objectContaining({ id: m.id, author: 'manager', text: 'Да, делаем 2100', authorName: 'Иван Петров' })]);
    const after = await ctx.deps.siteChat.get(sess.id);
    expect(after!.seenAt).toBeInstanceOf(Date);
    expect(Date.now() - after!.seenAt!.getTime()).toBeLessThan(10_000);
    expect(await ctx.deps.siteChat.hasNote(sess.id, 7001)).toBe(true);
    expect(await ctx.deps.siteChat.hasNote(sess.id, 7002)).toBe(false);
    // Опрос для SSE: новые сообщения после id, без сдвига простоя.
    const before = (await ctx.deps.siteChat.get(sess.id))!.lastSeenAt;
    const pulled = await ctx.app.siteChatService.pull(sess.id, m.id - 1);
    expect(pulled!.messages.map((x) => x.id)).toEqual([m.id]);
    expect((await ctx.deps.siteChat.get(sess.id))!.lastSeenAt.getTime()).toBe(before.getTime());
  });

  it('агент выключен — автоответ системным сообщением, заявка всё равно создана', async () => {
    await enable({ agentEnabled: false });
    const r = await post('/site-chat/v1/session', form({ phone: '+7 999 222-33-44', message: 'нужна входная' }), '10.1.1.4');
    expect(r.statusCode).toBe(200);
    expect(r.json().messages.map((m: { author: string }) => m.author)).toEqual(['client']);
    await ctx.app.siteChatService.idle();
    const msgs = await ctx.deps.siteChat.messages(r.json().session);
    expect(msgs.map((m) => m.author)).toEqual(['client', 'system']);
    expect(msgs[1]?.text).toContain('Менеджер перезвонит');
    expect(await ctx.deps.siteChat.get(r.json().session)).toMatchObject({ amoSync: 'pending' });
    await enable({ agentEnabled: true });
  });
});
