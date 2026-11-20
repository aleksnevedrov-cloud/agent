import type { WidgetPrincipal } from '@core/amo';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Deps } from '../deps.ts';

/**
 * RFD-SITE-CHAT-AGENT: вкладка «Чат сайта» в виджете amo — последние диалоги с сайта, расход канала за сегодня,
 * строка скрипта для шаблона UMI. Контакты клиентов видит только пользователь аккаунта (токен виджета).
 */
export function widgetSiteChatRoutes(api: FastifyInstance, deps: Deps, principal: (req: FastifyRequest) => WidgetPrincipal) {
  api.get('/site-chat/overview', async (req) => {
    const p = principal(req);
    const [sessions, costToday, { settings }] = await Promise.all([deps.siteChat.list(p.accountId, 30), deps.siteChat.costToday(p.accountId), deps.settings.get(p.accountId)]);
    const base = deps.env.PUBLIC_URL.replace(/\/$/, '');
    return {
      scriptTag: `<script src="${base}/site-chat/widget.js" async></script>`,
      demoUrl: `${base}/site-chat/demo`,
      costTodayRub: costToday,
      dailyBudgetRub: settings.siteChat.dailyBudgetRub,
      sessions: sessions.map((s) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        name: s.name,
        phone: s.phone,
        state: s.state,
        messages: s.messages,
        amoSync: s.amoSync,
        amoLeadId: s.amoLeadId,
        amoError: s.amoError,
        pageUrl: s.pageUrl,
        /** Окно на связи: пинг был меньше 90 с назад. */
        online: !!s.seenAt && Date.now() - s.seenAt.getTime() < 90_000,
      })),
    };
  });

  api.get('/site-chat/sessions/:id', async (req, reply) => {
    const p = principal(req);
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f]{32}$/.test(id)) return reply.code(400).send({ error: 'bad_id' });
    const s = await deps.siteChat.get(id);
    if (!s || s.accountId !== p.accountId) return reply.code(404).send({ error: 'not_found' });
    const messages = await deps.siteChat.messages(id);
    return { session: { ...s, createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString() }, messages: messages.map((m) => ({ id: m.id, author: m.author, text: m.text, at: m.createdAt.toISOString(), costRub: m.costRub, amoSync: m.amoSync })) };
  });
}
