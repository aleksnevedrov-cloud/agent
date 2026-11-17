import { CANVAS_GROUP, parseSize } from '@retail/catalog';
import { calculate, emptyRules, isConfigured, type CalcInput } from '@retail/pricing';
import { z } from 'zod';
import { defineTool } from './types.ts';

const door = z.object({
  product_id: z.string().min(1).max(100),
  width_mm: z.number().int().min(300).max(3000).optional(),
  height_mm: z.number().int().min(1000).max(3500).optional(),
  qty: z.number().int().min(1).max(500),
});

export const priceCalculate = defineTool({
  name: 'price_calculate',
  specName: 'price.calculate',
  description:
    'Расчёт стоимости заказа по правилам магазина: полотна из каталога × количество, комплект (коробка, наличники), ' +
    'доборы, фурнитура, услуги (доставка, подъём, занос, монтаж). Возвращает черновик детализации: строки с ценой и ' +
    'суммой, итог и список позиций, цену которых уточнит менеджер. Любую сумму, итог или стоимость комплекта ' +
    'называйте только из результата этого инструмента. Коды доборов и услуг — в системной инструкции.',
  inputSchema: {
    type: 'object',
    properties: {
      doors: {
        type: 'array',
        description: 'Полотна: id товара из каталога, размер проёма (ширина × высота полотна, мм), количество.',
        items: {
          type: 'object',
          properties: {
            product_id: { type: 'string' },
            width_mm: { type: 'integer' },
            height_mm: { type: 'integer' },
            qty: { type: 'integer', minimum: 1 },
          },
          required: ['product_id', 'qty'],
          additionalProperties: false,
        },
      },
      kit: { type: 'boolean', description: 'Добавить комплект (коробка, наличники). По умолчанию да.' },
      extras: {
        type: 'array',
        description: 'Доборы и другие позиции по коду с общим количеством.',
        items: {
          type: 'object',
          properties: { code: { type: 'string' }, qty: { type: 'integer', minimum: 1 } },
          required: ['code', 'qty'],
          additionalProperties: false,
        },
      },
      products: {
        type: 'array',
        description: 'Фурнитура и другие товары из каталога.',
        items: {
          type: 'object',
          properties: { product_id: { type: 'string' }, qty: { type: 'integer', minimum: 1 } },
          required: ['product_id', 'qty'],
          additionalProperties: false,
        },
      },
      card_components: {
        type: 'array',
        description:
          'Комплектующие из карточки двери (инструмент door_components): название и цена с сайта. Если переданы, комплектующие из «Правил цен» не используются.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            price_rub: { type: 'number' },
            qty: { type: 'integer', minimum: 1 },
          },
          required: ['name', 'price_rub'],
          additionalProperties: false,
        },
      },
      services: {
        type: 'array',
        description: 'Услуги по коду; для доставки за МКАД — km, для подъёма и заноса — floor.',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            km: { type: 'number' },
            floor: { type: 'integer' },
            qty: { type: 'number', description: 'Количество, если услуга нужна не на все двери (например, врезка замка на 2 двери из 4) или в погонных метрах.' },
          },
          required: ['code'],
          additionalProperties: false,
        },
      },
    },
    required: ['doors'],
    additionalProperties: false,
  },
  input: z.object({
    doors: z.array(door).max(50),
    kit: z.boolean().optional(),
    extras: z.array(z.object({ code: z.string().max(40), qty: z.number().int().min(1).max(1000) })).max(30).optional(),
    products: z.array(z.object({ product_id: z.string().max(100), qty: z.number().int().min(1).max(1000) })).max(30).optional(),
    card_components: z
      .array(z.object({ name: z.string().max(200), price_rub: z.number().min(0).max(1000000), qty: z.number().int().min(1).max(100).optional() }))
      .max(30)
      .optional(),
    services: z
      .array(z.object({ code: z.string().max(40), km: z.number().min(0).max(1000).optional(), floor: z.number().int().min(0).max(100).optional(), qty: z.number().min(0.1).max(1000).optional() }))
      .max(20)
      .optional(),
  }),
  async run(ctx, i) {
    // Полотна и комплектующие из карточки считаются и без «Правил цен»; правила нужны для услуг.
    const rules = ctx.pricing ?? emptyRules();
    const notFound: string[] = [];
    const doors: CalcInput['doors'] = [];
    for (const d of i.doors) {
      const p = await ctx.catalog.get(ctx.accountId, d.product_id);
      if (!p) {
        notFound.push(d.product_id);
        continue;
      }
      let cardSize: CalcInput['doors'][number]['cardSize'];
      if (d.width_mm && d.height_mm && ctx.components && p.url) {
        // Цена полотна по размеру - из торговых предложений карточки (поле «Размер полотна»).
        try {
          const sizes = (await ctx.components.forProduct(ctx.accountId, String(p.id ?? d.product_id), p.url)).filter(
            (x) => x.group === CANVAS_GROUP,
          );
          if (sizes.length) {
            const hit = sizes.find((x) => {
              const s = parseSize(x.name);
              return s !== null && s.heightMm === d.height_mm && s.widthMm === d.width_mm;
            });
            cardSize = hit ? { price: hit.price, label: hit.name } : { price: null, label: null };
          }
        } catch {
          // карточка не прочитана - считаем по каталогу и правилам, как раньше
        }
      }
      doors.push({ productId: p.id, name: p.name, category: p.category, price: p.price, widthMm: d.width_mm, heightMm: d.height_mm, qty: d.qty, cardSize });
    }
    const products: CalcInput['products'] = [];
    for (const x of i.products ?? []) {
      const p = await ctx.catalog.get(ctx.accountId, x.product_id);
      if (!p) notFound.push(x.product_id);
      else products.push({ productId: p.id, name: p.name, price: p.price, qty: x.qty });
    }
    if (notFound.length) return { empty: true, content: { error: `Товары не найдены в каталоге: ${notFound.join(', ')}` } };

    const cardComponents = (i.card_components ?? []).map((c) => ({ name: c.name, price: c.price_rub, qty: c.qty }));
    const r = calculate(rules, {
      doors,
      kit: i.kit ?? true,
      extras: i.extras ?? [],
      products,
      services: i.services ?? [],
      cardComponents,
    });
    const content = {
      lines: r.lines.map((l) => ({ name: l.name, qty: l.qty, price_rub: l.price, total_rub: l.total, basis: l.basis })),
      total_rub: r.total,
      complete: r.complete,
      price_unknown_for: r.missing,
      disclaimer: rules.disclaimer,
    };
    return {
      content,
      calculation: r,
      sources: doors.map((d) => ({ type: 'product' as const, id: d.productId, title: d.name })),
    };
  },
});

/** Коды доборов и услуг — для переменной части системной инструкции. */
export function pricingCodesHint(rules: import('@retail/pricing').PricingRules | null | undefined): string | null {
  if (!rules || !isConfigured(rules)) {
    return 'Услуги (монтаж, замер, доставка) в правилах цен не настроены: их стоимость не называйте, её считает менеджер. Полотна и комплектующие считайте price_calculate.';
  }
  const extras = rules.components.filter((c) => !c.inKit || c.qtyPerDoor === 0).map((c) => `${c.code} — ${c.name}`);
  const services = rules.services.map((s) => `${s.code} — ${s.name}`);
  return [
    extras.length ? `Коды позиций для price_calculate (extras): ${extras.join('; ')}.` : '',
    services.length ? `Коды услуг для price_calculate (services): ${services.join('; ')}.` : '',
    `Стандартные ширины полотна, мм: ${rules.sizes.standardWidths.join(', ')}; высоты: ${rules.sizes.standardHeights.join(', ')}.`,
  ]
    .filter(Boolean)
    .join('\n');
}
