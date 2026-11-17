import { pricingRulesSchema, type PricingRules, type Service } from './rules.ts';

/**
 * Услуги РФ-Двери для «Правил цен» (RFD-AI-AGENT-RASCHET, раздел 2 п. 5).
 * Источник — https://www.rf-dveri.ru/ustanovka_dverej/ (снято 17.11.2026). Доставки и подъёма на странице нет — не заводим.
 * Роспуск наличника — за погонный метр: агент передаёт метры через `qty` в услугах price_calculate.
 */
export const RF_DVERI_SERVICES: readonly Service[] = [
  { code: 'install_interior_2plus', name: 'Установка межкомнатной двери (от 2 шт.), за дверь', unit: 'per_door', price: 8000, basePrice: 0, freeFromDoors: null },
  { code: 'install_interior_1', name: 'Установка межкомнатной двери (только 1 шт.)', unit: 'fixed', price: 10000, basePrice: 0, freeFromDoors: null },
  { code: 'install_sliding', name: 'Установка раздвижной двери, одинарная', unit: 'per_door', price: 8500, basePrice: 0, freeFromDoors: null },
  { code: 'install_book', name: 'Установка складной двери-книжки, стандартная', unit: 'per_door', price: 9000, basePrice: 0, freeFromDoors: null },
  { code: 'install_enamel', name: 'Установка эмалевой двери, одинарная', unit: 'per_door', price: 8500, basePrice: 0, freeFromDoors: null },
  { code: 'install_massiv', name: 'Установка двери из массива дерева', unit: 'per_door', price: 6000, basePrice: 0, freeFromDoors: null },
  { code: 'install_hidden', name: 'Установка скрытой двери Invisible', unit: 'per_door', price: 7000, basePrice: 0, freeFromDoors: null },
  { code: 'install_roto', name: 'Установка складной двери с рото-механизмом, одинарная', unit: 'per_door', price: 6500, basePrice: 0, freeFromDoors: null },
  { code: 'install_compack', name: 'Установка складной двери с механизмом Compack, одинарная', unit: 'per_door', price: 8000, basePrice: 0, freeFromDoors: null },
  { code: 'install_entrance_metal', name: 'Установка входной металлической двери до 80 кг', unit: 'per_door', price: 7000, basePrice: 0, freeFromDoors: null },
  { code: 'install_entrance_wood', name: 'Установка входной деревянной двери, одинарная', unit: 'per_door', price: 20000, basePrice: 0, freeFromDoors: null },
  { code: 'install_entrance_alu', name: 'Установка входной алюминиевой двери до 80 кг', unit: 'per_door', price: 7500, basePrice: 0, freeFromDoors: null },
  { code: 'lock_cylinder', name: 'Врезка замка под цилиндр', unit: 'per_door', price: 900, basePrice: 0, freeFromDoors: null },
  { code: 'lock_wc', name: 'Врезка замка сантехнического', unit: 'per_door', price: 900, basePrice: 0, freeFromDoors: null },
  { code: 'dobor_install', name: 'Установка добора до 100 мм', unit: 'per_door', price: 800, basePrice: 0, freeFromDoors: null },
  { code: 'portal_install', name: 'Установка портала', unit: 'per_door', price: 4500, basePrice: 0, freeFromDoors: null },
  { code: 'door_correction', name: 'Коррекция двери: верх/низ', unit: 'per_door', price: 1500, basePrice: 0, freeFromDoors: null },
  { code: 'casing_cut', name: 'Роспуск наличника обычный, за п. м', unit: 'per_door', price: 150, basePrice: 0, freeFromDoors: null },
  { code: 'casing_cut_tele', name: 'Роспуск наличника телескоп, за п. м', unit: 'per_door', price: 200, basePrice: 0, freeFromDoors: null },
  { code: 'rigel', name: 'Врезка ригеля на распашную дверь', unit: 'per_door', price: 200, basePrice: 0, freeFromDoors: null },
  { code: 'hinge_extra', name: 'Врезка дополнительной петли', unit: 'per_door', price: 200, basePrice: 0, freeFromDoors: null },
  { code: 'threshold', name: 'Установка порога', unit: 'per_door', price: 200, basePrice: 0, freeFromDoors: null },
  { code: 'demont_entrance', name: 'Демонтаж входной двери', unit: 'per_door', price: 1500, basePrice: 0, freeFromDoors: null },
  { code: 'capitel_finish', name: 'Отделка проёма капителью (одна сторона)', unit: 'per_door', price: 700, basePrice: 0, freeFromDoors: null },
  { code: 'opening_vertical', name: 'Расширение и сужение проёма вертикально', unit: 'per_door', price: 1000, basePrice: 0, freeFromDoors: null },
  { code: 'opening_horizontal', name: 'Расширение и сужение проёма горизонтально', unit: 'per_door', price: 500, basePrice: 0, freeFromDoors: null },
  { code: 'demont_box', name: 'Демонтаж дверной коробки и полотна', unit: 'per_door', price: 500, basePrice: 0, freeFromDoors: null },
  { code: 'consumables', name: 'Комплект расходных материалов на одну дверь', unit: 'per_door', price: 500, basePrice: 0, freeFromDoors: null },
  { code: 'measure', name: 'Вызов замерщика: в пределах МКАД 2 000 ₽, за МКАД +50 ₽/км, от 4 дверей бесплатно', unit: 'per_km', price: 50, basePrice: 2000, freeFromDoors: 4 },
];

/**
 * Добавляет услуги пресета в правила аккаунта: услуги с теми же кодами заменяются, остальные (и комплектующие,
 * размеры, пояснение) остаются. Результат проверен схемой.
 */
export function withPresetServices(rules: PricingRules, preset: readonly Service[] = RF_DVERI_SERVICES): PricingRules {
  const codes = new Set(preset.map((s) => s.code));
  return pricingRulesSchema.parse({ ...rules, services: [...rules.services.filter((s) => !codes.has(s.code)), ...preset] });
}
