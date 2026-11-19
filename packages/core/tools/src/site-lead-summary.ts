import { z } from 'zod';
import { defineTool } from './types.ts';

/**
 * RFD-SITE-CHAT-AGENT: сводка для менеджера по чату сайта — одно примечание «Сводка Аммы» в заявке,
 * повторный вызов обновляет его. Запись в amoCRM делает очередь воркера через порт `siteLead`.
 */
export interface SiteLeadPort {
  /** Сохранить сводку (и при `task` — поставить задачу «Перезвонить клиенту с сайта»). */
  saveSummary(summary: SiteLeadSummary, opts: { task: boolean }): Promise<void>;
}

export interface SiteLeadSummary {
  need: string;
  sizes: string | null;
  quantity: string | null;
  color: string | null;
  products: { name: string; url: string | null; price: number | null }[];
  services: string | null;
  address: string | null;
  callTime: string | null;
  open: string | null;
}

const schema = z.object({
  need: z.string().min(1).max(600),
  sizes: z.string().max(300).nullable().default(null),
  quantity: z.string().max(100).nullable().default(null),
  color: z.string().max(200).nullable().default(null),
  products: z.array(z.object({ name: z.string().max(200), url: z.string().max(500).nullable().default(null), price: z.number().nullable().default(null) })).max(10).default([]),
  services: z.string().max(300).nullable().default(null),
  address: z.string().max(300).nullable().default(null),
  call_time: z.string().max(200).nullable().default(null),
  open: z.string().max(600).nullable().default(null),
  task: z.boolean().default(true),
});

export function formatSiteSummary(s: SiteLeadSummary): string {
  const lines = ['Сводка Аммы (чат сайта)', `Что ищет: ${s.need}`];
  if (s.sizes) lines.push(`Размеры: ${s.sizes}`);
  if (s.quantity) lines.push(`Количество: ${s.quantity}`);
  if (s.color) lines.push(`Цвет / покрытие: ${s.color}`);
  if (s.products.length) lines.push(`Предложено: ${s.products.map((p) => `${p.name}${p.price ? ` — ${p.price} ₽` : ''}${p.url ? ` ${p.url}` : ''}`).join('; ')}`);
  if (s.services) lines.push(`Замер / доставка / установка: ${s.services}`);
  if (s.address) lines.push(`Адрес: ${s.address}`);
  if (s.callTime) lines.push(`Удобное время звонка: ${s.callTime}`);
  if (s.open) lines.push(`Осталось неясным: ${s.open}`);
  return lines.join('\n');
}

export const siteLeadSummary = defineTool({
  name: 'site_lead_summary',
  specName: 'site.lead_summary',
  description:
    'Записать сводку для менеджера в заявку клиента с сайта: что ищет, размеры, количество, цвет, предложенные товары, ' +
    'замер/доставка/установка, адрес, удобное время звонка, что осталось неясным. Вызывайте перед передачей менеджеру и ' +
    'когда клиент назвал время звонка или попросил перезвонить. Повторный вызов обновляет сводку. ' +
    'С task=true менеджер получает задачу «Перезвонить клиенту с сайта».',
  inputSchema: {
    type: 'object',
    properties: {
      need: { type: 'string', description: 'Что ищет клиент, одной-двумя фразами' },
      sizes: { type: 'string', description: 'Размеры проёмов или полотен' },
      quantity: { type: 'string', description: 'Сколько дверей' },
      color: { type: 'string', description: 'Цвет, покрытие, стиль' },
      products: {
        type: 'array',
        items: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' }, price: { type: 'number' } }, required: ['name'], additionalProperties: false },
        description: 'Предложенные товары со ссылками и ценами из каталога',
      },
      services: { type: 'string', description: 'Нужны ли замер, доставка, установка' },
      address: { type: 'string', description: 'Город, район или адрес' },
      call_time: { type: 'string', description: 'Когда удобно принять звонок менеджера' },
      open: { type: 'string', description: 'Что осталось неясным' },
      task: { type: 'boolean', description: 'Поставить задачу «Перезвонить клиенту с сайта» (по умолчанию да)' },
    },
    required: ['need'],
    additionalProperties: false,
  },
  input: schema,
  async run(ctx, i) {
    const port = ctx.siteLead;
    if (!port) return { content: { ok: false, reason: 'Сводка доступна только в чате сайта' } };
    const summary: SiteLeadSummary = {
      need: i.need,
      sizes: i.sizes,
      quantity: i.quantity,
      color: i.color,
      products: i.products.map((p) => ({ name: p.name, url: p.url, price: p.price })),
      services: i.services,
      address: i.address,
      callTime: i.call_time,
      open: i.open,
    };
    await port.saveSummary(summary, { task: i.task });
    return { content: { ok: true, task: i.task } };
  },
});
