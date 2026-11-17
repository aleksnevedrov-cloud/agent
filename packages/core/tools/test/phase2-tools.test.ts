import { pricingRulesSchema } from '@retail/pricing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crmCreateTask, InMemoryMemory, memorySave, PHASE2_TOOLS, priceCalculate, pricingCodesHint, SandboxCrm, type ToolContext } from '../src/index.ts';
import { seeded, type Seeded } from './fixtures.ts';

let s: Seeded;
let ctx: ToolContext;
let crm: SandboxCrm;
const rules = pricingRulesSchema.parse({
  sizes: { nonStandardMarkupPct: 30 },
  components: [
    { code: 'box', name: 'Коробка телескоп', qtyPerDoor: 2.5, prices: [{ series: 'Турин', price: 1500 }], defaultPrice: 1200 },
    { code: 'casing', name: 'Наличник телескоп', qtyPerDoor: 5, defaultPrice: 800 },
    { code: 'ext_100', name: 'Добор 100мм телескоп', qtyPerDoor: 0, inKit: false, defaultPrice: 900 },
  ],
  services: [{ code: 'delivery_mkad', name: 'Доставка в пределах МКАД', unit: 'fixed', price: 1500 }],
});

beforeAll(async () => {
  s = await seeded();
  crm = new SandboxCrm();
  ctx = { accountId: 1, catalog: s.catalog, knowledge: s.knowledge, crm, pricing: rules, memory: new InMemoryMemory(), tasks: { measure: { taskTypeId: 5, deadlineMin: 120 } } };
});
afterAll(async () => s.drop());

describe('price_calculate', () => {
  it('считает комплект по каталогу и правилам, итог — в данных инструмента', async () => {
    const r = await priceCalculate.run(
      ctx,
      priceCalculate.input.parse({
        doors: [
          { product_id: '1001', width_mm: 800, height_mm: 2000, qty: 2 },
          { product_id: '1001', width_mm: 750, height_mm: 2000, qty: 1 },
        ],
        extras: [{ code: 'ext_100', qty: 3 }],
        services: [{ code: 'delivery_mkad' }],
      }),
    );
    const c = r.content as { lines: { name: string; qty: number; price_rub: number }[]; total_rub: number; complete: boolean };
    // 14 900 × 2 + 19 370 (+30 %) + коробка 8 × 1 500 + наличник 15 × 800 + добор 3 × 900 + доставка 1 500
    expect(c.lines.find((l) => l.name.endsWith('75*200'))?.price_rub).toBe(19370);
    expect(c.lines.find((l) => l.name === 'Коробка телескоп')).toMatchObject({ qty: 8, price_rub: 1500 });
    expect(c.total_rub).toBe(29800 + 19370 + 12000 + 12000 + 2700 + 1500);
    expect(c.complete).toBe(true);
    expect(r.calculation).toBeDefined();
  });

  it('без правил — полотна и комплектующие карточки всё равно считаются', async () => {
    const r = await priceCalculate.run(
      { ...ctx, pricing: null },
      { doors: [{ product_id: '1001', qty: 2 }], card_components: [{ name: 'Коробка Стандартная', price_rub: 1156, qty: 5 }] },
    );
    expect(r.empty).toBeFalsy();
    const c = r.content as { total_rub: number; complete: boolean };
    expect(c.total_rub).toBe(14900 * 2 + 1156 * 5);
    expect(c.complete).toBe(true);
  });

  it('цена полотна по размеру — из карточки; размера нет на сайте — менеджер', async () => {
    const components = {
      forProduct: async () => [
        { group: 'Размер полотна', name: '2000*800', price: 16000 },
        { group: 'Размер полотна', name: '2600*800', price: 21500 },
        { group: 'Коробка', name: 'Стандартная', price: 1156 },
      ],
    };
    const r = await priceCalculate.run(
      { ...ctx, pricing: null, components },
      {
        doors: [
          { product_id: '1001', width_mm: 800, height_mm: 2600, qty: 1 },
          { product_id: '1001', width_mm: 800, height_mm: 3000, qty: 1 },
        ],
      },
    );
    const c = r.content as { lines: { name: string; price_rub: number | null; basis: string }[]; total_rub: number; complete: boolean; price_unknown_for: string[] };
    expect(c.lines[0]).toMatchObject({ price_rub: 21500 });
    expect(c.lines[0]?.basis).toMatch(/2600\*800 из карточки/);
    expect(c.lines[1]).toMatchObject({ price_rub: null });
    expect(c.lines[1]?.basis).toMatch(/нет на сайте/);
    expect(c.total_rub).toBe(21500);
    expect(c.complete).toBe(false);
  });

  it('услуги: количество не на все двери и бесплатный замер от 4 дверей', async () => {
    const withSvc = pricingRulesSchema.parse({
      services: [
        { code: 'lock_cylinder', name: 'Врезка замка под цилиндр', unit: 'per_door', price: 900 },
        { code: 'measure', name: 'Вызов замерщика', unit: 'per_km', price: 50, basePrice: 2000, freeFromDoors: 4 },
      ],
    });
    const two = await priceCalculate.run(
      { ...ctx, pricing: withSvc },
      { doors: [{ product_id: '1001', qty: 2 }], services: [{ code: 'lock_cylinder', qty: 1 }, { code: 'measure', km: 10 }] },
    );
    const c2 = two.content as { lines: { name: string; qty: number; total_rub: number | null }[] };
    expect(c2.lines.find((l) => l.name.startsWith('Врезка'))).toMatchObject({ qty: 1, total_rub: 900 });
    expect(c2.lines.find((l) => l.name.startsWith('Вызов'))).toMatchObject({ total_rub: 2500 });
    const four = await priceCalculate.run({ ...ctx, pricing: withSvc }, { doors: [{ product_id: '1001', qty: 4 }], services: [{ code: 'measure', km: 10 }] });
    const c4 = four.content as { lines: { name: string; total_rub: number | null }[] };
    expect(c4.lines.find((l) => l.name.startsWith('Вызов'))).toMatchObject({ total_rub: 0 });
  });

  it('неизвестный товар — ошибка', async () => {
    const r = await priceCalculate.run(ctx, { doors: [{ product_id: 'nope', qty: 1 }] });
    expect(JSON.stringify(r.content)).toMatch(/не найдены/);
  });

  it('подсказка с кодами для системной инструкции', () => {
    expect(pricingCodesHint(rules)).toMatch(/ext_100 — Добор 100мм телескоп/);
    expect(pricingCodesHint(null)).toMatch(/не настроены/);
  });
});

describe('crm_create_task и memory_save', () => {
  it('задача берёт тип и срок из настроек', async () => {
    await crmCreateTask.run(ctx, { type: 'measure', text: 'Замер в субботу утром' });
    await crmCreateTask.run(ctx, { type: 'callback', text: 'Перезвонить после 18:00' });
    expect(crm.tasks).toEqual([
      { text: 'AI: Согласовать замер. Замер в субботу утром', taskTypeId: 5, deadlineMin: 120 },
      { text: 'AI: Перезвонить клиенту. Перезвонить после 18:00', taskTypeId: 1, deadlineMin: 60 },
    ]);
  });

  it('память накапливается', async () => {
    await memorySave.run(ctx, memorySave.input.parse({ openings: [{ room: 'спальня', width_mm: 800, height_mm: 2000 }], chosen: [{ id: '1001', name: 'Турин 1' }] }));
    await memorySave.run(ctx, memorySave.input.parse({ budget_rub: 60000, rejected: [{ id: '1001', name: 'Турин 1', reason: 'дорого' }] }));
    const m = await ctx.memory!.get();
    expect(m).toMatchObject({ budget_rub: 60000, chosen: [], rejected: [{ id: '1001', reason: 'дорого' }] });
    expect(m.openings).toHaveLength(1);
  });

  it('PHASE2_TOOLS содержит все инструменты', () => {
    expect(PHASE2_TOOLS.map((t) => t.specName)).toEqual([
      'catalog.search',
      'catalog.get_product',
      'door_components',
      'knowledge.search',
      'crm.get_context',
      'crm.add_note',
      'crm.handoff',
      'price.calculate',
      'crm.create_task',
      'memory.save',
    ]);
  });
});
