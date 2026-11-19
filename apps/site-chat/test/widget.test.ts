// @vitest-environment jsdom
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// В среде jsdom import.meta.url не file: — корень пакета берём из cwd (vitest запускается из apps/site-chat).
const root = process.cwd();
const API = 'https://ai.test.ru';
let js = '';

type Call = { url: string; body: unknown };
const calls: Call[] = [];
let config: Record<string, unknown> = {};
let sessionResponse: Record<string, unknown> = {};

function installFetch() {
  calls.length = 0;
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/site-chat/v1/config')) return new Response(JSON.stringify(config), { status: 200 });
    if (url.endsWith('/site-chat/v1/session')) return new Response(JSON.stringify(sessionResponse), { status: 200 });
    if (url.includes('/site-chat/v1/messages')) return new Response(JSON.stringify({ state: 'active', messages: [] }), { status: 200 });
    if (url.endsWith('/site-chat/v1/message')) return new Response(JSON.stringify({ message: { id: 7, author: 'client', text: body.text, products: [], at: new Date().toISOString() } }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

/** Загружает собранный виджет как скрипт сайта. */
function load() {
  document.body.innerHTML = '';
  document.getElementById('rfd-site-chat')?.remove();
  const s = document.createElement('script');
  s.src = `${API}/site-chat/widget.js`;
  document.head.appendChild(s);
  Object.defineProperty(document, 'currentScript', { value: s, configurable: true });
  new Function(js)();
  Object.defineProperty(document, 'currentScript', { value: null, configurable: true });
}

const flush = () => new Promise((r) => setTimeout(r, 20));
const shadow = () => document.getElementById('rfd-site-chat')!.shadowRoot!;
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeAll(() => {
  execFileSync('node', ['scripts/build.mjs'], { cwd: root });
  js = readFileSync(`${root}/dist/widget.js`, 'utf8');
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  config = { enabled: true, online: true, texts: { greeting: 'Здравствуйте, я Амма', autoReply: 'Спасибо!', fallbackPhone: '+7 (495) 000-00-00' }, popup: { enabled: false, delaySec: 0, text: '', pages: [], mobile: false }, privacyUrl: 'https://www.rf-dveri.ru/policy/', limits: { messageMaxLen: 2000, messageMinIntervalMs: 0 } };
  sessionResponse = { session: 'a'.repeat(32), state: 'active', messages: [{ id: 1, author: 'client', text: 'привет', products: [], at: new Date().toISOString() }, { id: 2, author: 'agent', text: 'Здравствуйте, я Амма', products: [], at: new Date().toISOString() }] };
  installFetch();
  (globalThis as { EventSource?: unknown }).EventSource = undefined;
});

describe('widget.js (RFD-SITE-CHAT-AGENT)', () => {
  it('не больше 40 КБ, без библиотек, тексты только через textContent', () => {
    expect(statSync(`${root}/dist/widget.js`).size).toBeLessThan(40 * 1024);
    expect(js).not.toMatch(/innerHTML/);
    expect(js).not.toMatch(/node_modules/);
  });

  it('читает config по адресу скрипта; выключен — ничего не рисует; включён — оранжевый ярлык', async () => {
    config = { enabled: false };
    load();
    await flush();
    expect(calls[0]?.url).toBe(`${API}/site-chat/v1/config`);
    expect(document.getElementById('rfd-site-chat')).toBeNull();
    config = { ...config, enabled: true, online: true, texts: { greeting: 'x', autoReply: 'y', fallbackPhone: 'z' }, popup: { enabled: false, delaySec: 0, text: '', pages: [], mobile: false } };
    load();
    await flush();
    const tab = shadow().querySelector<HTMLButtonElement>('.tab')!;
    expect(tab.textContent).toContain('Напишите нам, мы онлайн!');
  });

  it('форма: кнопка активна только при заполненных полях и согласии; телефон с 8 уходит как 7XXXXXXXXXX; ловушка и UTM передаются', async () => {
    sessionStorage.setItem('rfd_chat_utm', JSON.stringify({ utm_source: 'yandex' }));
    load();
    await flush();
    shadow().querySelector<HTMLButtonElement>('.tab')!.click();
    const form = shadow().querySelector('form')!;
    const btn = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(btn.disabled).toBe(true);
    const field = (name: string) => form.querySelector<HTMLInputElement>(`[name=${name}]`)!;
    type(field('name'), 'Павел');
    type(field('email'), 'pavel@example.com');
    type(field('phone'), '89261234567');
    expect(field('phone').value).toBe('+7 (926) 123-45-67');
    type(form.querySelector<HTMLTextAreaElement>('[name=message]')!, 'дверь-книжка 340+340');
    expect(btn.disabled).toBe(true);
    field('consent').checked = true;
    field('consent').dispatchEvent(new Event('change', { bubbles: true }));
    expect(btn.disabled).toBe(false);
    expect(form.querySelector('.consent a')?.getAttribute('href')).toBe('https://www.rf-dveri.ru/policy/');
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    const post = calls.find((c) => c.url.endsWith('/site-chat/v1/session'))!;
    expect(post.body).toMatchObject({ name: 'Павел', email: 'pavel@example.com', phone: '79261234567', message: 'дверь-книжка 340+340', consent: true, website: '', utm: { utm_source: 'yandex' } });
    expect(typeof (post.body as { opened_at: number }).opened_at).toBe('number');
    // Экран 2: пузыри клиента и агента, имя «Амма», session_id сохранён.
    const bubbles = [...shadow().querySelectorAll('.m')].map((b) => b.className);
    expect(bubbles).toEqual(['m client', 'm agent']);
    expect(shadow().querySelector('.who')?.textContent).toBe('Амма');
    expect(localStorage.getItem('rfd_chat_session')).toBe('a'.repeat(32));
    // Без EventSource — опрос истории.
    expect(calls.some((c) => c.url.includes('/site-chat/v1/messages?session='))).toBe(true);
  });

  it('повторный визит: сессия из localStorage, история с сервера, форма не показывается; отправка сообщения', async () => {
    localStorage.setItem('rfd_chat_session', 'b'.repeat(32));
    localStorage.setItem('rfd_chat_open', '1');
    load();
    await flush();
    await flush();
    expect(shadow().querySelector('form')).toBeNull();
    const ta = shadow().querySelector<HTMLTextAreaElement>('.foot textarea')!;
    type(ta, 'ещё вопрос');
    shadow().querySelector<HTMLButtonElement>('.send')!.click();
    await flush();
    const post = calls.find((c) => c.url.endsWith('/site-chat/v1/message'))!;
    expect(post.body).toEqual({ session: 'b'.repeat(32), text: 'ещё вопрос' });
    expect([...shadow().querySelectorAll('.m.client')].at(-1)?.textContent).toContain('ещё вопрос');
  });

  it('ошибка сети на форме — текст с телефоном, данные остаются', async () => {
    load();
    await flush();
    shadow().querySelector<HTMLButtonElement>('.tab')!.click();
    const form = shadow().querySelector('form')!;
    const field = (name: string) => form.querySelector<HTMLInputElement>(`[name=${name}]`)!;
    type(field('name'), 'Анна');
    type(field('email'), 'a@b.ru');
    type(field('phone'), '+7 999 000 00 00');
    type(form.querySelector<HTMLTextAreaElement>('[name=message]')!, 'хочу дверь');
    field('consent').checked = true;
    field('consent').dispatchEvent(new Event('change', { bubbles: true }));
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network');
    }) as typeof fetch;
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    expect(form.textContent).toContain('Не удалось отправить. Позвоните +7 (495) 000-00-00');
    expect(field('name').value).toBe('Анна');
    expect(shadow().querySelector('form')).not.toBeNull();
  });

  it('в админке UMI не грузится; всплывание по задержке и маскам страниц', async () => {
    history.replaceState(null, '', '/admin/content/');
    load();
    await flush();
    expect(document.getElementById('rfd-site-chat')).toBeNull();
    history.replaceState(null, '', '/catalog/dveri/');
    config = { ...config, popup: { enabled: true, delaySec: 0, text: 'Подскажу по дверям', pages: ['/catalog/*'], mobile: true } };
    load();
    await flush();
    await flush();
    const pop = shadow().querySelector('.popup')!;
    expect(pop.textContent).toContain('Подскажу по дверям');
    pop.querySelector('b')!.click();
    expect(shadow().querySelector('.popup')).toBeNull();
    expect(sessionStorage.getItem('rfd_chat_popup_done')).toBe('1');
  });
});
