/**
 * RFD-SITE-CHAT-AGENT: окно чата на rf-dveri.ru (копия окна Jivo по ТЗ RFD-SITE-CHAT, разделы 3, 3.1, 3.2).
 * Чистый TypeScript без библиотек, все стили в Shadow DOM. Тексты выводятся только через textContent.
 * Адрес API берётся из адреса самого скрипта (https://ai.rf-dveri.ru/site-chat/widget.js).
 */

interface Config {
  enabled: boolean;
  online?: boolean;
  texts?: { greeting: string; autoReply: string; fallbackPhone: string };
  popup?: { enabled: boolean; delaySec: number; text: string; pages: string[]; mobile: boolean };
  privacyUrl?: string;
  /** Шторка «Связаться с нами» на телефоне: ссылки на мессенджеры и почта (пусто — строки нет). */
  contacts?: { whatsapp: string; telegram: string; max: string; email: string };
  limits?: { messageMaxLen: number; messageMinIntervalMs: number };
  sessionTtlDays?: number;
}

interface Product {
  id: string;
  name: string;
  price: number | null;
  url: string | null;
  picture: string | null;
}

interface Msg {
  id: number;
  author: 'client' | 'agent' | 'system';
  text: string;
  products: Product[];
  at: string;
  /** Локальные пометки: не доставлено / отправляется. */
  local?: 'sending' | 'failed';
}

const SITE_HOST = /(^|\.)rf-dveri\.ru$/i;
/** Ссылки шторки «Связаться с нами» — только на сами мессенджеры (настройку вводит администратор, но окно живёт на чужом сайте). */
const MESSENGER_HOSTS = /^(wa\.me|api\.whatsapp\.com|t\.me|telegram\.me|max\.ru|web\.max\.ru)$/i;
function messengerUrl(u: string): string | null {
  try {
    const x = new URL(u.trim());
    return x.protocol === 'https:' && MESSENGER_HOSTS.test(x.hostname) ? x.href : null;
  } catch {
    return null;
  }
}
const KEY_SESSION = 'rfd_chat_session';
const KEY_OPEN = 'rfd_chat_open';
const KEY_SOUND = 'rfd_chat_sound';
const KEY_POPUP = 'rfd_chat_popup_done';
const KEY_UTM = 'rfd_chat_utm';
const COLORS = { green: '#3E8914', greenDark: '#357A10', text: '#1B1F23', grey: '#6A737D', grey2: '#959DA5', field: '#F0F3F4', error: '#F94636', orange: '#EE7A22' };

const script = document.currentScript as HTMLScriptElement | null;
const apiBase = (() => {
  try {
    return new URL(script?.src ?? '', location.href).origin;
  } catch {
    return '';
  }
})();

function main(): void {
  if (!apiBase) return;
  if (/^\/admin(\/|$)/.test(location.pathname)) return; // админка UMI
  if (document.getElementById('rfd-site-chat')) return;
  rememberUtm();
  fetch(`${apiBase}/site-chat/v1/config`, { credentials: 'omit' })
    .then((r) => (r.ok ? (r.json() as Promise<Config>) : null))
    .then((cfg) => {
      if (cfg?.enabled) new ChatWidget(cfg).mount();
    })
    .catch(() => undefined);
}

function rememberUtm(): void {
  try {
    const q = new URLSearchParams(location.search);
    const utm: Record<string, string> = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      const v = q.get(k);
      if (v) utm[k] = v.slice(0, 300);
    }
    if (Object.keys(utm).length && !sessionStorage.getItem(KEY_UTM)) sessionStorage.setItem(KEY_UTM, JSON.stringify(utm));
  } catch {
    /* sessionStorage недоступен (приватный режим) */
  }
}

const store = {
  get(k: string, session = false): string | null {
    try {
      return (session ? sessionStorage : localStorage).getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null, session = false): void {
    try {
      const s = session ? sessionStorage : localStorage;
      if (v === null) s.removeItem(k);
      else s.setItem(k, v);
    } catch {
      /* нет хранилища — работаем без памяти */
    }
  },
};

const cookie = (name: string): string | null => {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1] ?? '') : null;
  } catch {
    return null; // cookie недоступны (страница без домена или запрет браузера) — отправляем форму без ClientID
  }
};

const isMobile = () => (typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 480px)').matches : window.innerWidth <= 480);
const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtPrice = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

/** Телефон: оставляем цифры, 8 → 7, показываем как +7 (XXX) XXX-XX-XX. */
function formatPhone(raw: string): { pretty: string; digits: string } {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('8')) d = `7${d.slice(1)}`;
  if (d && !d.startsWith('7')) d = `7${d}`;
  d = d.slice(0, 11);
  const p = d.slice(1);
  let pretty = '+7';
  if (p.length) pretty += ` (${p.slice(0, 3)}`;
  if (p.length >= 3) pretty += ')';
  if (p.length > 3) pretty += ` ${p.slice(3, 6)}`;
  if (p.length > 6) pretty += `-${p.slice(6, 8)}`;
  if (p.length > 8) pretty += `-${p.slice(8, 10)}`;
  return { pretty, digits: d };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const STYLES = `
:host{all:initial}
*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.tab{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483000;background:${COLORS.orange};color:#fff;border:0;border-radius:8px 0 0 8px;padding:14px 10px;cursor:pointer;writing-mode:vertical-rl;transform:translateY(-50%) rotate(180deg);font-size:14px;font-weight:600;letter-spacing:.2px;box-shadow:0 2px 10px rgba(0,0,0,.2)}
.tab .dot{position:absolute;left:6px;bottom:6px;width:9px;height:9px;border-radius:50%;background:${COLORS.green};border:2px solid #fff}
.tab .badge{position:absolute;left:-6px;top:-6px;min-width:20px;height:20px;border-radius:10px;background:${COLORS.error};color:#fff;font-size:12px;line-height:20px;text-align:center;padding:0 5px;writing-mode:horizontal-tb;transform:rotate(180deg)}
.win{position:fixed;right:24px;bottom:24px;width:336px;max-width:calc(100vw - 48px);height:496px;max-height:calc(100vh - 48px);z-index:2147483001;background:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.22);display:flex;flex-direction:column;overflow:hidden;color:${COLORS.text}}
.close{position:absolute;right:14px;top:14px;width:32px;height:32px;border-radius:50%;background:transparent;border:0;cursor:pointer;font-size:24px;line-height:32px;color:#fff;z-index:2}
.close:hover{background:rgba(255,255,255,.15)}
.wrap{position:fixed;right:24px;bottom:24px;width:336px;max-width:calc(100vw - 48px);height:0;z-index:2147483001}
.head{position:relative;background:${COLORS.green};color:#fff;padding:12px 48px 10px 14px;display:flex;gap:12px;align-items:flex-start}
.head .ico{flex:none;width:30px;height:30px;margin-top:2px}
.head h3{margin:0;font-size:16px;font-weight:700;line-height:1.2}
.head p{margin:4px 0 0;font-size:13px;color:rgba(255,255,255,.9)}
.body{flex:1;overflow:auto;padding:10px 14px;background:#fff}
.field{margin:0 0 6px}
.field label{display:block;font-size:12px;font-weight:700;color:${COLORS.text};margin-bottom:3px}
.field input,.field textarea{width:100%;border:1px solid #d9dde1;border-radius:8px;padding:7px 10px;font-size:13px;color:${COLORS.text};outline:0;background:#fff;resize:vertical}
.field input::placeholder,.field textarea::placeholder{color:${COLORS.grey2}}
.field input:focus,.field textarea:focus{border-color:${COLORS.green};box-shadow:0 0 0 2px rgba(62,137,20,.15)}
.field.err input,.field.err textarea{border-color:${COLORS.error}}
.hint{font-size:11px;color:${COLORS.error};min-height:14px;margin-top:2px}
.consent{display:flex;gap:10px;align-items:flex-start;font-size:12px;color:${COLORS.text};margin:2px 0 8px;line-height:1.35}
.consent input{width:20px;height:20px;margin:1px 0 0;flex:none;accent-color:${COLORS.green}}
.consent a{display:block;color:${COLORS.green};text-decoration:underline}
.hp{position:absolute;left:-9999px;top:-9999px;height:0;width:0;opacity:0}
.btn{width:100%;border:0;border-radius:10px;background:${COLORS.green};color:#fff;font-size:15px;font-weight:700;padding:10px;cursor:pointer}
.btn:hover{background:${COLORS.greenDark}}
.btn:disabled{opacity:.5;cursor:default}
.msgs{display:flex;flex-direction:column;gap:8px}
.m{max-width:84%;padding:8px 12px;border-radius:14px;font-size:14px;line-height:1.35;white-space:pre-wrap;word-break:break-word}
.m.client{align-self:flex-end;background:${COLORS.green};color:#fff;border-bottom-right-radius:4px}
.m.agent{align-self:flex-start;background:${COLORS.field};color:${COLORS.text};border-bottom-left-radius:4px}
.m.system{align-self:center;background:transparent;color:${COLORS.grey};font-size:12px;text-align:center}
.meta{font-size:10px;opacity:.7;margin-top:4px;text-align:right}
.m.agent .meta{text-align:left}
.who{font-size:11px;color:${COLORS.grey2};margin:0 0 2px 4px}
.cards{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.card{display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #e3e6e8;border-radius:8px;padding:6px;text-decoration:none;color:${COLORS.text}}
.card img{width:48px;height:48px;object-fit:cover;border-radius:6px;background:${COLORS.field}}
.card .n{font-size:12px;line-height:1.3}
.card .p{font-size:13px;font-weight:700;color:${COLORS.green}}
.typing{align-self:flex-start;background:${COLORS.field};border-radius:14px;padding:10px 14px;display:flex;gap:4px}
.typing i{width:6px;height:6px;border-radius:50%;background:${COLORS.grey2};animation:b 1.2s infinite}
.typing i:nth-child(2){animation-delay:.2s}.typing i:nth-child(3){animation-delay:.4s}
@keyframes b{0%,80%,100%{opacity:.3}40%{opacity:1}}
.foot{display:flex;gap:8px;align-items:flex-end;padding:10px 12px;border-top:1px solid #eceff1;background:#fff}
.foot textarea{flex:1;border:0;background:${COLORS.field};border-radius:18px;padding:9px 14px;font-size:14px;max-height:90px;resize:none;outline:0}
.send{width:38px;height:38px;border-radius:50%;border:0;background:${COLORS.green};color:#fff;cursor:pointer;font-size:16px;flex:none}
.send:disabled{opacity:.5}
.offline{font-size:12px;color:${COLORS.error};text-align:center;padding:4px 10px;background:#fff6f5}
.retry{color:#fff;text-decoration:underline;cursor:pointer;font-size:11px;margin-top:3px;display:block}
.sound{position:absolute;right:44px;top:14px;background:transparent;border:0;cursor:pointer;font-size:14px;opacity:.7}
.popup{position:fixed;right:52px;bottom:24px;z-index:2147483000;background:#fff;color:${COLORS.text};border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.2);padding:12px 36px 12px 14px;font-size:13px;max-width:260px;cursor:pointer}
.popup b{position:absolute;right:10px;top:6px;color:${COLORS.grey2};font-weight:400;cursor:pointer}
.dim{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:2147483001}
.sheet{position:fixed;left:0;right:0;bottom:0;max-height:92vh;overflow:auto;background:#fff;border-radius:22px 22px 0 0;z-index:2147483002;color:#292828;padding-bottom:28px}
.sheet .grip{width:40px;height:4px;border-radius:2px;background:#e0e0e0;margin:8px auto}
.sheet .ttl{display:flex;align-items:center;gap:8px;padding:0 16px;height:48px}
.sheet .ttl h3{flex:1;margin:0;font-size:20px;font-weight:600;line-height:28px}
.sheet .x{width:44px;height:44px;border-radius:22px;background:#f7f7f7;border:0;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;flex:none}
.sheet .x img{width:24px;height:24px}
.sheet .line{height:1px;background:#2d7500;margin:12px 16px 0}
.sheet .sec{padding:16px 16px 0;display:flex;flex-direction:column;gap:8px}
.sheet h4{margin:0;font-size:16px;font-weight:600;line-height:24px}
.sheet .item{display:flex;align-items:center;gap:16px;height:56px;padding:0 16px;border-radius:8px;background:#f7f7f7;color:#292828;text-decoration:none;font-size:16px;border:0;width:100%;cursor:pointer;text-align:left}
.sheet .item .i{width:32px;height:32px;flex:none}
.sheet .item span{flex:1}
.sheet .item .c{width:16px;height:16px;flex:none}
.sheet .cb{padding:16px 16px 0;display:flex;flex-direction:column;gap:12px}
.sheet .ph{display:flex;align-items:center;gap:8px;height:48px;border:1px solid #e0e0e0;border-radius:8px;padding:0 16px}
.sheet .ph.err{border-color:${COLORS.error}}
.sheet .ph img{width:20px;height:20px}
.sheet .ph input{flex:1;border:0;outline:0;font-size:16px;color:#292828;background:transparent;min-width:0}
.sheet .cbtn{height:48px;border:0;border-radius:8px;background:#2d7500;color:#fff;font-size:16px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer}
.sheet .cbtn img{width:20px;height:20px}
.sheet .cbtn:disabled{opacity:.5}
.sheet .note{font-size:12px;line-height:17px;color:#6b6b6b;margin:0}
.sheet .note a{color:#6b6b6b}
.sheet .done{font-size:15px;color:#2d7500;margin:0}
@media (max-width:480px){.win{right:0;left:0;bottom:0;width:100%;max-width:100%;height:100%;max-height:100%;border-radius:0}.wrap{right:0;bottom:0;width:100%;max-width:100%}.tab{top:auto;bottom:12%;transform:rotate(180deg);padding:10px 7px;font-size:12px}.popup{right:12px;left:12px;max-width:none}}
`;

class ChatWidget {
  private root!: ShadowRoot;
  private host!: HTMLDivElement;
  private tab!: HTMLButtonElement;
  private badge!: HTMLSpanElement;
  private win: HTMLDivElement | null = null;
  /** Шторка «Связаться с нами» (телефон): подложка с самой шторкой внутри. */
  private sheet: HTMLDivElement | null = null;
  private body!: HTMLDivElement;
  private msgsEl!: HTMLDivElement;
  private typingEl: HTMLDivElement | null = null;
  private input: HTMLTextAreaElement | null = null;
  private offlineEl: HTMLDivElement | null = null;
  private session: string | null = store.get(KEY_SESSION);
  private messages: Msg[] = [];
  private lastId = 0;
  private state = 'active';
  private es: EventSource | null = null;
  private pollTimer: number | null = null;
  private reconnectStep = 0;
  private unread = 0;
  private openedAt = Date.now();
  private sound = store.get(KEY_SOUND) !== 'off';
  private lastSentAt = 0;
  private audio: AudioContext | null = null;

  constructor(private readonly cfg: Config) {}

  mount(): void {
    this.host = el('div');
    this.host.id = 'rfd-site-chat';
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = STYLES;
    this.root.appendChild(style);
    // На телефоне ярлык короче и ниже ярлыков «На складе / В салоне» карточки товара (правка заказчика 19.11.2026).
    this.tab = el('button', 'tab', isMobile() ? 'Мы онлайн' : 'Напишите нам, мы онлайн!');
    this.tab.type = 'button';
    this.tab.setAttribute('aria-label', 'Открыть чат');
    this.tab.appendChild(el('span', 'dot'));
    this.badge = el('span', 'badge');
    this.badge.hidden = true;
    this.tab.appendChild(this.badge);
    this.tab.addEventListener('click', () => this.open());
    this.root.appendChild(this.tab);
    document.body.appendChild(this.host);

    if (this.session) {
      // Возвращение: история подгружается с сервера, окно — в прежнем состоянии.
      this.loadHistory().then(() => {
        if (store.get(KEY_OPEN) === '1') this.open();
        else this.connect();
      });
    } else {
      this.schedulePopup();
    }
    window.addEventListener('pagehide', () => this.disconnect());
  }

  private schedulePopup(): void {
    const p = this.cfg.popup;
    if (!p?.enabled || store.get(KEY_POPUP, true) === '1') return;
    if (isMobile() && !p.mobile) return;
    if (p.pages.length && !p.pages.some((mask) => matchPage(mask, location.pathname + location.search))) return;
    window.setTimeout(() => {
      if (this.win || this.session || store.get(KEY_POPUP, true) === '1') return;
      const pop = el('div', 'popup', p.text || 'Здравствуйте! Подскажу по дверям.');
      const x = el('b', undefined, '×');
      pop.appendChild(x);
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        pop.remove();
        store.set(KEY_POPUP, '1', true);
      });
      pop.addEventListener('click', () => {
        pop.remove();
        this.open();
      });
      this.root.appendChild(pop);
    }, Math.max(0, p.delaySec) * 1000);
  }

  /**
   * Ярлык / всплывание: на компьютере — окно чата размера Jivo; на телефоне — шторка «Связаться с нами» по макету
   * Figma «2026 / Написать / Связаться с нами / Мобильная / 390», кроме возврата в уже открытый чат.
   */
  open(): void {
    store.set(KEY_POPUP, '1', true);
    if (this.win || this.sheet) return;
    if (isMobile() && !(this.session && store.get(KEY_OPEN) === '1')) this.openSheet();
    else this.openChat();
  }

  private openChat(): void {
    if (this.win) return;
    this.tab.hidden = true;
    this.unread = 0;
    this.badge.hidden = true;
    store.set(KEY_OPEN, '1');
    const wrap = el('div', 'wrap');
    const win = el('div', 'win');
    this.win = win;
    wrap.appendChild(win);
    this.root.appendChild(wrap);
    if (this.session) this.renderChat();
    else this.renderForm();
  }

  close(): void {
    this.sheet?.remove();
    this.sheet = null;
    this.win?.parentElement?.remove();
    this.win = null;
    this.input = null;
    this.typingEl = null;
    this.tab.hidden = false;
    store.set(KEY_OPEN, '0');
  }

  // ---------- Телефон: шторка «Связаться с нами» ----------
  private openSheet(): void {
    this.tab.hidden = true;
    const asset = (name: string) => `${apiBase}/site-chat/assets/${name}`;
    const icon = (name: string, cls: string) => {
      const img = el('img', cls);
      img.src = asset(name);
      img.alt = '';
      return img;
    };
    const dim = el('div', 'dim');
    dim.addEventListener('click', () => this.close());
    const sh = el('div', 'sheet');
    sh.addEventListener('click', (e) => e.stopPropagation());
    dim.appendChild(sh);
    this.sheet = dim;
    sh.appendChild(el('div', 'grip'));
    const ttl = el('div', 'ttl');
    ttl.appendChild(el('h3', undefined, 'Связаться с нами'));
    const x = el('button', 'x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Закрыть');
    x.appendChild(icon('close.svg', ''));
    x.addEventListener('click', () => this.close());
    ttl.appendChild(x);
    sh.appendChild(ttl);
    sh.appendChild(el('div', 'line'));

    const sec = el('div', 'sec');
    sec.appendChild(el('h4', undefined, 'Написать'));
    const row = (name: string, text: string, href: string | null) => {
      const it = href ? el('a', 'item') : el('button', 'item');
      if (it instanceof HTMLAnchorElement) {
        it.href = href ?? '';
        it.target = '_blank';
        it.rel = 'noopener';
      } else it.type = 'button';
      it.appendChild(icon(name, 'i'));
      it.appendChild(el('span', undefined, text));
      it.appendChild(icon('chevron.svg', 'c'));
      sec.appendChild(it);
      return it;
    };
    row('chat.svg', 'Онлайн-чат', null).addEventListener('click', () => {
      this.sheet?.remove();
      this.sheet = null;
      this.openChat();
    });
    const c = this.cfg.contacts;
    const max = c?.max ? messengerUrl(c.max) : null;
    const wa = c?.whatsapp ? messengerUrl(c.whatsapp) : null;
    const tg = c?.telegram ? messengerUrl(c.telegram) : null;
    if (max) row('max.png', 'MAX', max);
    if (wa) row('whatsapp.svg', 'WhatsApp', wa);
    if (tg) row('telegram.svg', 'Telegram', tg);
    if (c?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) row('mail.svg', 'Написать на почту', `mailto:${c.email}`);
    sh.appendChild(sec);

    // Заказать звонок: телефон → заявка в «Неразобранном» и задача «Перезвонить», без агента.
    const cb = el('form', 'cb');
    cb.noValidate = true;
    cb.appendChild(el('h4', undefined, 'Заказать звонок'));
    const ph = el('label', 'ph');
    ph.appendChild(icon('phone.svg', ''));
    const phone = el('input');
    phone.type = 'tel';
    phone.name = 'phone';
    phone.placeholder = '+7 (___) ___-__-__';
    phone.autocomplete = 'tel';
    phone.inputMode = 'tel';
    ph.appendChild(phone);
    cb.appendChild(ph);
    const hp = el('input', 'hp');
    hp.type = 'text';
    hp.name = 'website';
    hp.tabIndex = -1;
    hp.autocomplete = 'off';
    hp.setAttribute('aria-hidden', 'true');
    cb.appendChild(hp);
    const btn = el('button', 'cbtn');
    btn.type = 'submit';
    btn.disabled = true;
    btn.appendChild(icon('phone-white.svg', ''));
    btn.appendChild(el('span', undefined, 'Заказать звонок'));
    cb.appendChild(btn);
    const note = el('p', 'note', 'Нажимая кнопку, вы соглашаетесь с ');
    if (this.cfg.privacyUrl) {
      const a = el('a', undefined, 'Политикой обработки персональных данных');
      a.href = this.cfg.privacyUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      note.appendChild(a);
    } else note.appendChild(el('span', undefined, 'политикой обработки персональных данных'));
    cb.appendChild(note);
    phone.addEventListener('input', () => {
      const { pretty, digits } = formatPhone(phone.value);
      phone.value = phone.value.trim() ? pretty : '';
      ph.classList.remove('err');
      btn.disabled = digits.length !== 11;
    });
    cb.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        const r = await fetch(`${apiBase}/site-chat/v1/callback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            phone: formatPhone(phone.value).digits,
            consent: true,
            website: hp.value,
            opened_at: this.openedAt,
            page_url: location.href.slice(0, 2000),
            page_title: document.title.slice(0, 300),
            referrer: document.referrer.slice(0, 2000) || undefined,
            utm: JSON.parse(store.get(KEY_UTM, true) ?? '{}') as Record<string, string>,
            ym_uid: cookie('_ym_uid') ?? undefined,
            ga_cid: cookie('_ga') ?? undefined,
          }),
        });
        if (r.status === 400) {
          ph.classList.add('err');
          throw new Error('validation');
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        cb.textContent = '';
        cb.appendChild(el('h4', undefined, 'Заказать звонок'));
        cb.appendChild(el('p', 'done', 'Спасибо! Менеджер перезвонит в ближайшее время.'));
      } catch (err) {
        if ((err as Error).message !== 'validation') note.textContent = `Не удалось отправить. Позвоните ${this.cfg.texts?.fallbackPhone ?? '+7 (495) 532-49-41'}`;
        btn.disabled = false;
      }
    });
    sh.appendChild(cb);
    this.root.appendChild(dim);
  }

  private header(title: string, sub: string): HTMLDivElement {
    const h = el('div', 'head');
    const ico = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ico.setAttribute('viewBox', '0 0 24 24');
    ico.setAttribute('class', 'ico');
    ico.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 3C7 3 3 6.4 3 10.6c0 2.2 1.1 4.2 2.9 5.6L5 21l4.6-2.3c.8.2 1.6.3 2.4.3 5 0 9-3.4 9-7.6S17 3 12 3zm-4 8.6a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4zm4 0a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4zm4 0a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4z');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#fff');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linejoin', 'round');
    ico.appendChild(path);
    h.appendChild(ico);
    const txt = el('div');
    txt.appendChild(el('h3', undefined, title));
    txt.appendChild(el('p', undefined, sub));
    h.appendChild(txt);
    const close = el('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Закрыть чат');
    close.addEventListener('click', () => this.close());
    h.appendChild(close);
    return h;
  }

  // ---------- Экран 1: форма ----------
  private renderForm(): void {
    const win = this.win;
    if (!win) return;
    win.appendChild(this.header('Представьтесь и начните чат', this.cfg.online ? 'Ответим за пару минут' : 'Оставьте сообщение'));
    const body = el('div', 'body');
    const form = el('form');
    form.noValidate = true;
    const f = (label: string, type: string, name: string, placeholder = '') => {
      const wrap = el('div', 'field');
      const lab = el('label', undefined, label);
      const input = type === 'textarea' ? el('textarea') : el('input');
      if (input instanceof HTMLInputElement) input.type = type;
      input.name = name;
      input.placeholder = placeholder;
      if (type === 'textarea') (input as HTMLTextAreaElement).rows = 2;
      wrap.appendChild(lab);
      wrap.appendChild(input);
      wrap.appendChild(el('div', 'hint'));
      form.appendChild(wrap);
      return input;
    };
    const name = f('Ваше имя*', 'text', 'name', 'Как к вам обращаться') as HTMLInputElement;
    name.autocomplete = 'name';
    const email = f('Ваш e-mail*', 'email', 'email', 'example@mail.ru') as HTMLInputElement;
    email.autocomplete = 'email';
    const phone = f('Ваш телефон*', 'tel', 'phone', '+7 (___) ___-__-__') as HTMLInputElement;
    phone.autocomplete = 'tel';
    phone.inputMode = 'tel';
    phone.addEventListener('input', () => {
      const { pretty } = formatPhone(phone.value);
      phone.value = phone.value.trim() ? pretty : '';
    });
    const message = f('Ваше сообщение*', 'textarea', 'message', 'Напишите ваш вопрос') as HTMLTextAreaElement;
    // Ловушка для ботов: поле невидимо, люди его не заполняют.
    const hp = el('input');
    hp.type = 'text';
    hp.name = 'website';
    hp.tabIndex = -1;
    hp.autocomplete = 'off';
    hp.className = 'hp';
    hp.setAttribute('aria-hidden', 'true');
    form.appendChild(hp);
    const consentWrap = el('label', 'consent');
    const consent = el('input');
    consent.type = 'checkbox';
    consent.name = 'consent';
    consentWrap.appendChild(consent);
    const ct = el('span', undefined, 'Согласен на обработку персональных данных');
    if (this.cfg.privacyUrl) {
      const a = el('a', undefined, 'Политика конфиденциальности');
      a.href = this.cfg.privacyUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      ct.appendChild(a);
    }
    consentWrap.appendChild(ct);
    form.appendChild(consentWrap);
    const btn = el('button', 'btn', 'Начать диалог →');
    btn.type = 'submit';
    btn.disabled = true;
    form.appendChild(btn);
    const errBox = el('div', 'hint');
    form.appendChild(errBox);

    const check = () => {
      const ok = name.value.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim()) && formatPhone(phone.value).digits.length === 11 && message.value.trim().length >= 2 && consent.checked;
      btn.disabled = !ok;
    };
    for (const i of [name, email, phone, message, consent]) i.addEventListener('input', check);
    consent.addEventListener('change', check);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Отправляем…';
      try {
        const r = await fetch(`${apiBase}/site-chat/v1/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: name.value.trim(),
            email: email.value.trim(),
            phone: formatPhone(phone.value).digits,
            message: message.value.trim(),
            consent: consent.checked,
            website: hp.value,
            opened_at: this.openedAt,
            page_url: location.href.slice(0, 2000),
            page_title: document.title.slice(0, 300),
            referrer: document.referrer.slice(0, 2000) || undefined,
            utm: JSON.parse(store.get(KEY_UTM, true) ?? '{}') as Record<string, string>,
            ym_uid: cookie('_ym_uid') ?? undefined,
            ga_cid: cookie('_ga') ?? undefined,
          }),
        });
        if (r.status === 400) {
          const j = (await r.json()) as { issues?: { path: string; message: string }[] };
          const issue = j.issues?.[0];
          const target = issue?.path === 'phone' ? phone : issue?.path === 'email' ? email : issue?.path === 'name' ? name : message;
          target.parentElement?.classList.add('err');
          const hint = target.parentElement?.querySelector('.hint');
          if (hint) hint.textContent = issue?.path === 'phone' ? 'Проверьте телефон: нужен номер из 11 цифр' : 'Проверьте поле';
          throw new Error('validation');
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { session: string; state: string; messages: Msg[] };
        this.session = j.session;
        store.set(KEY_SESSION, j.session);
        this.state = j.state;
        this.messages = j.messages;
        this.lastId = Math.max(0, ...j.messages.map((m) => m.id));
        body.remove();
        win.querySelector('.head')?.remove();
        this.renderChat();
      } catch (err) {
        if ((err as Error).message !== 'validation') errBox.textContent = `Не удалось отправить. Позвоните ${this.cfg.texts?.fallbackPhone ?? '+7 (495) 532-49-41'}`;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Начать диалог →';
        check();
      }
    });
    body.appendChild(form);
    win.appendChild(body);
    this.body = body;
    window.setTimeout(() => name.focus(), 50);
  }

  // ---------- Экран 2: переписка ----------
  private renderChat(): void {
    const win = this.win;
    if (!win) return;
    const head = this.header('Напишите ваше сообщение', this.cfg.online ? 'Онлайн' : 'Оставьте сообщение');
    const snd = el('button', 'sound', this.sound ? '🔔' : '🔕');
    snd.type = 'button';
    snd.title = 'Звук уведомлений';
    snd.addEventListener('click', () => {
      this.sound = !this.sound;
      store.set(KEY_SOUND, this.sound ? 'on' : 'off');
      snd.textContent = this.sound ? '🔔' : '🔕';
    });
    head.appendChild(snd);
    win.appendChild(head);
    this.offlineEl = el('div', 'offline', 'Нет соединения, пробуем снова…');
    this.offlineEl.hidden = true;
    win.appendChild(this.offlineEl);
    const body = el('div', 'body');
    this.msgsEl = el('div', 'msgs');
    body.appendChild(this.msgsEl);
    win.appendChild(body);
    this.body = body;
    const foot = el('div', 'foot');
    const ta = el('textarea');
    ta.placeholder = 'Введите сообщение';
    ta.rows = 1;
    ta.maxLength = this.cfg.limits?.messageMaxLen ?? 2000;
    const send = el('button', 'send', '➤');
    send.type = 'button';
    send.setAttribute('aria-label', 'Отправить');
    const submit = () => {
      const text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      void this.send(text);
    };
    send.addEventListener('click', submit);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    foot.appendChild(ta);
    foot.appendChild(send);
    win.appendChild(foot);
    this.input = ta;
    for (const m of this.messages) this.appendMessage(m, false);
    this.scroll();
    this.connect();
    window.setTimeout(() => ta.focus(), 50);
  }

  private appendMessage(m: Msg, fresh: boolean): void {
    if (!this.msgsEl) return;
    const old = this.msgsEl.querySelector(`[data-id="${m.id}"]`);
    if (old && m.id > 0) return;
    const box = el('div', `m ${m.author}`);
    if (m.id > 0) box.dataset.id = String(m.id);
    if (m.author === 'agent' && (this.msgsEl.lastElementChild as HTMLElement | null)?.classList.contains('client') !== false) {
      // Имя агента над первым пузырём серии.
      const prev = this.msgsEl.lastElementChild as HTMLElement | null;
      if (!prev || !prev.classList.contains('agent')) this.msgsEl.appendChild(el('div', 'who', 'Амма'));
    }
    box.appendChild(el('span', undefined, m.text));
    if (m.products?.length) {
      const cards = el('div', 'cards');
      for (const p of m.products.slice(0, 3)) {
        const a = el('a', 'card');
        if (p.url && safeUrl(p.url)) a.href = p.url;
        const img = el('img');
        img.alt = '';
        img.loading = 'lazy';
        if (p.picture && safeUrl(p.picture)) img.src = p.picture;
        a.appendChild(img);
        const txt = el('div');
        txt.appendChild(el('div', 'n', p.name));
        if (p.price) txt.appendChild(el('div', 'p', fmtPrice(p.price)));
        a.appendChild(txt);
        cards.appendChild(a);
      }
      box.appendChild(cards);
    }
    if (m.author !== 'system') {
      const meta = el('div', 'meta', m.local === 'sending' ? 'отправляется…' : m.local === 'failed' ? 'Не доставлено' : `${fmtTime(m.at)}${m.author === 'client' ? ' ✓✓' : ''}`);
      box.appendChild(meta);
      if (m.local === 'failed') {
        const retry = el('span', 'retry', 'Отправить ещё раз?');
        retry.addEventListener('click', () => {
          box.remove();
          void this.send(m.text);
        });
        box.appendChild(retry);
      }
    }
    this.msgsEl.appendChild(box);
    if (fresh) this.scroll();
  }

  private scroll(): void {
    if (this.body) this.body.scrollTop = this.body.scrollHeight;
  }

  private setTyping(on: boolean): void {
    if (!this.msgsEl) return;
    if (on && !this.typingEl) {
      this.typingEl = el('div', 'typing');
      for (let i = 0; i < 3; i++) this.typingEl.appendChild(el('i'));
      this.msgsEl.appendChild(this.typingEl);
      this.scroll();
    } else if (!on && this.typingEl) {
      this.typingEl.remove();
      this.typingEl = null;
    }
  }

  private async send(text: string): Promise<void> {
    if (!this.session) return;
    const minGap = this.cfg.limits?.messageMinIntervalMs ?? 3000;
    const wait = minGap - (Date.now() - this.lastSentAt);
    if (wait > 0) await new Promise((r) => window.setTimeout(r, wait));
    const local: Msg = { id: -Date.now(), author: 'client', text, products: [], at: new Date().toISOString(), local: 'sending' };
    this.appendMessage(local, true);
    const node = this.msgsEl?.lastElementChild as HTMLElement | null;
    try {
      const r = await fetch(`${apiBase}/site-chat/v1/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: this.session, text }) });
      if (r.status === 404) {
        // Сессия истекла: форма заново.
        this.resetSession();
        return;
      }
      if (r.status === 429) throw new Error('rate');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.lastSentAt = Date.now();
      const j = (await r.json()) as { message: Msg };
      node?.remove();
      this.lastId = Math.max(this.lastId, j.message.id);
      this.appendMessage(j.message, true);
    } catch {
      node?.remove();
      this.appendMessage({ ...local, local: 'failed' }, true);
    }
  }

  private resetSession(): void {
    this.disconnect();
    this.session = null;
    this.messages = [];
    this.lastId = 0;
    store.set(KEY_SESSION, null);
    if (this.win) {
      this.win.textContent = '';
      this.renderForm();
    }
  }

  private async loadHistory(): Promise<void> {
    if (!this.session) return;
    try {
      const r = await fetch(`${apiBase}/site-chat/v1/messages?session=${this.session}&after=0`);
      if (r.status === 404) {
        this.session = null;
        store.set(KEY_SESSION, null);
        this.schedulePopup();
        return;
      }
      if (!r.ok) return;
      const j = (await r.json()) as { state: string; messages: Msg[] };
      this.state = j.state;
      this.messages = j.messages;
      this.lastId = Math.max(0, ...j.messages.map((m) => m.id));
    } catch {
      /* нет связи — покажем, что есть */
    }
  }

  // ---------- Доставка ответов: SSE, запасной путь — опрос ----------
  private connect(): void {
    if (!this.session || this.es || this.pollTimer) return;
    if (typeof EventSource === 'undefined') {
      this.startPolling();
      return;
    }
    const es = new EventSource(`${apiBase}/site-chat/v1/stream?session=${this.session}&after=${this.lastId}`);
    this.es = es;
    es.addEventListener('open', () => {
      this.reconnectStep = 0;
      if (this.offlineEl) this.offlineEl.hidden = true;
    });
    es.addEventListener('message', (e) => this.onEvent(JSON.parse((e as MessageEvent).data) as { message: Msg }));
    es.addEventListener('typing', (e) => this.setTyping((JSON.parse((e as MessageEvent).data) as { on: boolean }).on));
    es.addEventListener('state', (e) => {
      this.state = (JSON.parse((e as MessageEvent).data) as { state: string }).state;
    });
    es.addEventListener('error', () => {
      es.close();
      this.es = null;
      if (this.offlineEl) this.offlineEl.hidden = false;
      const delays = [1000, 2000, 5000, 10000];
      const delay = delays[Math.min(this.reconnectStep, delays.length - 1)] ?? 10000;
      this.reconnectStep += 1;
      // После четырёх неудач — опрос раз в 3 с, SSE пробуем снова позже.
      if (this.reconnectStep > delays.length) this.startPolling();
      else window.setTimeout(() => this.connect(), delay);
    });
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    const tick = async () => {
      if (!this.session) return;
      try {
        const r = await fetch(`${apiBase}/site-chat/v1/messages?session=${this.session}&after=${this.lastId}`);
        if (r.ok) {
          if (this.offlineEl) this.offlineEl.hidden = true;
          const j = (await r.json()) as { state: string; messages: Msg[] };
          this.state = j.state;
          for (const m of j.messages) this.onEvent({ message: m });
        }
      } catch {
        if (this.offlineEl) this.offlineEl.hidden = false;
      }
    };
    this.pollTimer = window.setInterval(() => void tick(), 3000);
    void tick();
    // Раз в минуту пробуем вернуться на SSE.
    window.setTimeout(() => {
      if (this.pollTimer) {
        window.clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.reconnectStep = 0;
        this.connect();
      }
    }, 60_000);
  }

  private disconnect(): void {
    this.es?.close();
    this.es = null;
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private onEvent(e: { message: Msg }): void {
    const m = e.message;
    if (!m || m.id <= this.lastId) return;
    this.lastId = m.id;
    this.messages.push(m);
    if (m.author !== 'client') this.setTyping(false);
    if (this.win) this.appendMessage(m, true);
    if (!this.win && m.author !== 'client') {
      this.unread += 1;
      this.badge.textContent = String(this.unread);
      this.badge.hidden = false;
      this.beep();
    } else if (m.author === 'agent') this.beep();
  }

  private beep(): void {
    if (!this.sound) return;
    try {
      this.audio ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const ctx = this.audio;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.03;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.12);
    } catch {
      /* звук недоступен до взаимодействия пользователя — молчим */
    }
  }
}

/** Ссылки в карточках — только на сайт (защита от подмены адреса). */
function safeUrl(u: string): boolean {
  try {
    const x = new URL(u, location.href);
    return x.protocol === 'https:' && SITE_HOST.test(x.hostname);
  } catch {
    return false;
  }
}

/** Маска страницы: подстрока адреса или шаблон с * в конце. */
export function matchPage(mask: string, path: string): boolean {
  const m = mask.trim();
  if (!m || m === '*' || m === '/*') return true;
  if (m.endsWith('*')) return path.startsWith(m.slice(0, -1));
  return path.includes(m);
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main, { once: true });
  else main();
}
