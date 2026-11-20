import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from '../deps.ts';
import { SiteChatService, type SiteEvent } from '../site-chat/service.ts';

/**
 * RFD-SITE-CHAT-AGENT: маршруты чата на сайте rf-dveri.ru. Без токена amo — это публичный сайт;
 * доступ к переписке только по случайному session_id (128 бит), CORS — только домены сайта (app.ts).
 */
declare module 'fastify' {
  interface FastifyInstance {
    /** Сервис чата сайта — тестам нужно дождаться фоновых ответов агента (`idle()`). */
    siteChatService: SiteChatService;
  }
}

export function siteChatRoutes(app: FastifyInstance, deps: Deps, service: SiteChatService = buildSiteChatService(deps, app.log)) {
  app.decorate('siteChatService', service);
  const ip = (req: FastifyRequest) => (req.ip ? String(req.ip).slice(0, 64) : null);

  app.get('/site-chat/widget.js', { config: { rateLimit: false } }, async (_req, reply) => {
    const js = widgetScript();
    if (!js) return reply.code(404).send('widget.js не собран: pnpm -C apps/site-chat build');
    return reply.type('application/javascript; charset=utf-8').header('cache-control', 'public, max-age=3600').send(js);
  });

  app.get('/site-chat/demo', { config: { rateLimit: false } }, async (_req, reply) => {
    const base = deps.env.PUBLIC_URL.replace(/\/$/, '');
    return reply.type('text/html; charset=utf-8').header('x-robots-tag', 'noindex').send(demoPage(base));
  });

  app.get('/site-chat/v1/health', { config: { rateLimit: false } }, async (_req, reply) => {
    const a = await service.account().catch(() => null);
    return reply.send({ status: 'ok', enabled: Boolean(a?.settings.siteChat.enabled), agent: Boolean(a?.settings.siteChat.agentEnabled), accountId: a?.accountId ?? null });
  });

  app.get('/site-chat/v1/config', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (_req, reply) => {
    return reply.header('cache-control', 'no-store').send(await service.config());
  });

  app.post('/site-chat/v1/session', { bodyLimit: 16 * 1024, config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const r = await service.start(req.body, { ip: ip(req), userAgent: req.headers['user-agent'] ?? null });
    if (!r.ok) return reply.code(r.status).send({ error: r.error, ...(r.issues ? { issues: r.issues } : {}) });
    return reply.send({ session: r.session.id, state: r.session.state === 'spam' ? 'active' : r.session.state, messages: r.messages, duplicate: r.duplicate });
  });

  app.post('/site-chat/v1/callback', { bodyLimit: 8 * 1024, config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const r = await service.callback(req.body, { ip: ip(req), userAgent: req.headers['user-agent'] ?? null });
    if (!r.ok) return reply.code(r.status).send({ error: r.error, ...(r.issues ? { issues: r.issues } : {}) });
    return reply.send({ ok: true, duplicate: r.duplicate });
  });

  // Иконки шторки «Связаться с нами» (из макета Figma): только файлы из apps/site-chat/assets, имя по белому списку.
  app.get('/site-chat/assets/:file', { config: { rateLimit: false } }, async (req, reply) => {
    const { file } = req.params as { file: string };
    if (!/^[a-z0-9-]{1,40}\.(svg|png)$/.test(file)) return reply.code(404).send('нет');
    const body = widgetAsset(file);
    if (!body) return reply.code(404).send('нет');
    return reply.type(file.endsWith('.svg') ? 'image/svg+xml' : 'image/png').header('cache-control', 'public, max-age=86400').send(body);
  });

  app.post('/site-chat/v1/message', { bodyLimit: 16 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const r = await service.message(req.body);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return reply.send({ message: r.message });
  });

  app.get('/site-chat/v1/messages', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = req.query as { session?: string; after?: string };
    if (!q.session || !/^[0-9a-f]{32}$/.test(q.session)) return reply.code(400).send({ error: 'bad_session' });
    const h = await service.history(q.session, Number(q.after ?? 0) || 0);
    if (!h) return reply.code(404).send({ error: 'no_session' });
    return reply.header('cache-control', 'no-store').send({ state: h.session.state, messages: h.messages });
  });

  // Server-Sent Events: одно соединение на окно, пинг раз в 25 с; nginx — proxy_buffering off.
  app.get('/site-chat/v1/stream', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = req.query as { session?: string; after?: string };
    if (!q.session || !/^[0-9a-f]{32}$/.test(q.session)) return reply.code(400).send({ error: 'bad_session' });
    const h = await service.history(q.session, Number(q.after ?? 0) || 0);
    if (!h) return reply.code(404).send({ error: 'no_session' });
    return stream(req, reply, service, q.session, h.messages.map((m): SiteEvent => ({ type: 'message', message: m })), h.session.state);
  });
}

function stream(req: FastifyRequest, reply: FastifyReply, service: SiteChatService, sessionId: string, backlog: SiteEvent[], state: string) {
  const origin = req.headers.origin;
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...(origin && reply.getHeader('access-control-allow-origin') ? { 'access-control-allow-origin': String(reply.getHeader('access-control-allow-origin')) } : {}),
  });
  const send = (e: SiteEvent) => {
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  res.write(`retry: 3000\n\n`);
  send({ type: 'state', state: state as SiteEvent extends { state: infer S } ? S : never });
  for (const e of backlog) send(e);
  let lastId = Math.max(0, ...backlog.map((e) => (e.type === 'message' ? e.message.id : 0)));
  let lastState = state;
  const off = service.subscribe(sessionId, (e) => {
    if (e.type === 'message') lastId = Math.max(lastId, e.message.id);
    send(e);
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  // Сообщения менеджера и смену состояния пишет воркер — раз в 3 с проверяем базу, заодно отмечаем «окно на связи».
  let busy = false;
  const poll = setInterval(() => {
    if (busy) return;
    busy = true;
    service
      .pull(sessionId, lastId)
      .then((p) => {
        if (!p) return;
        for (const m of p.messages) {
          if (m.id <= lastId) continue;
          lastId = m.id;
          send({ type: 'message', message: m });
        }
        if (p.state !== lastState) {
          lastState = p.state;
          send({ type: 'state', state: p.state });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, 3000);
  const close = () => {
    clearInterval(ping);
    clearInterval(poll);
    off();
    if (!res.writableEnded) res.end();
  };
  req.raw.on('close', close);
  req.raw.on('error', close);
}

export function buildSiteChatService(deps: Deps, log?: { error(obj: object, msg: string): void; warn(obj: object, msg: string): void }): SiteChatService {
  return new SiteChatService({
    env: deps.env,
    accounts: deps.accounts,
    settings: deps.settings,
    siteChat: deps.siteChat,
    log: deps.log ?? log,
    turn: {
      ai: deps.ai,
      settings: deps.settings,
      journal: deps.journal,
      siteChat: deps.siteChat,
      catalog: deps.catalog,
      knowledge: deps.knowledge,
      pricing: async (accountId) => (await deps.pricing.get(accountId)).rules,
      components: deps.doorComponents,
    },
  });
}

let cachedScript: string | null | undefined;
/** Скрипт окна: собранный в apps/api/dist/site-chat/widget.js (Docker) или в apps/site-chat/dist (разработка). */
export function widgetScript(): string | null {
  if (cachedScript !== undefined && process.env.NODE_ENV === 'production') return cachedScript;
  const candidates = [new URL('./site-chat/widget.js', import.meta.url), new URL('../site-chat/widget.js', import.meta.url), new URL('../../../site-chat/dist/widget.js', import.meta.url)];
  for (const u of candidates) {
    const p = fileURLToPath(u);
    if (existsSync(p)) {
      cachedScript = readFileSync(p, 'utf8');
      return cachedScript;
    }
  }
  cachedScript = null;
  return null;
}

const assetCache = new Map<string, Buffer | null>();
export function widgetAsset(file: string): Buffer | null {
  const hit = assetCache.get(file);
  if (hit !== undefined && process.env.NODE_ENV === 'production') return hit;
  const candidates = [new URL(`./site-chat/assets/${file}`, import.meta.url), new URL(`../site-chat/assets/${file}`, import.meta.url), new URL(`../../../site-chat/assets/${file}`, import.meta.url)];
  for (const u of candidates) {
    const p = fileURLToPath(u);
    if (existsSync(p)) {
      const b = readFileSync(p);
      assetCache.set(file, b);
      return b;
    }
  }
  assetCache.set(file, null);
  return null;
}

/** Демо-страница для приёмки: только для проверки, на сайт не ставится. */
export function demoPage(base: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Демо чата сайта</title>
<style>body{font-family:system-ui,-apple-system,Arial,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#1B1F23;line-height:1.5}h1{font-size:22px}code{background:#F0F3F4;padding:2px 6px;border-radius:4px}</style></head>
<body><h1>Демо-страница чата rf-dveri.ru</h1>
<p>Так окно выглядит на сайте. Нажмите оранжевый ярлык справа или подождите всплывания. Сообщения уходят в amoCRM так же, как с настоящего сайта.</p>
<p>Строка для шаблона UMI: <code>&lt;script src="${base}/site-chat/widget.js" async&gt;&lt;/script&gt;</code></p>
<p>Проверка: <a href="${base}/site-chat/v1/health">/site-chat/v1/health</a> · <a href="${base}/site-chat/v1/config">/site-chat/v1/config</a></p>
<script src="${base}/site-chat/widget.js" async></script></body></html>`;
}
