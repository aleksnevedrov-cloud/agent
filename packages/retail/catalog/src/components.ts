/**
 * Комплектующие из карточки двери на rf-dveri.ru (RFD-AI-AGENT-KOMPLEKTUYUWIE).
 * Связка «дверь -> коробка/наличник/добор» не попадает ни в YML-фид, ни в /upage/<id>.json,
 * поэтому единственный источник - HTML карточки, блок ComponentsInTheFormOfTradeOffers.
 * У каждой двери свои варианты и свои цены - общие «Правила цен» дают неверную сумму.
 */

export interface DoorComponent {
  /** Группа без двоеточия: Коробка, Наличник, Добор, Карниз, Розетка, Цоколь, Плинтус и др. */
  group: string;
  name: string;
  pageId: number | null;
  offerId: number | null;
  price: number;
}

const BLOCK = 'ComponentsInTheFormOfTradeOffers';
const TITLE_RE = /class="Title[^"]*"[^>]*>\s*([^<]+)/;
const INPUT_RE = /<input\b[^>]*name="ComponentInTheFormOfTradeOffer[^>]*>/g;

function attr(tag: string, name: string): string | null {
  const m = new RegExp(name + '="([^"]*)"').exec(tag);
  return m ? (m[1] ?? null) : null;
}

function clean(s: string): string {
  return s.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Разбирает HTML карточки. Пустой массив - блока нет (товар без комплектующих), это не ошибка. */
export function parseDoorComponents(html: string): DoorComponent[] {
  const out: DoorComponent[] = [];
  const parts = html.split(BLOCK);
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] ?? '';
    const title = TITLE_RE.exec(part);
    const group = title ? clean(title[1] ?? '').replace(/:$/, '') : '';
    if (!group) continue;
    for (const tag of part.match(INPUT_RE) ?? []) {
      const value = attr(tag, 'value') ?? '';
      if (!value) continue; // первый вариант группы - «не выбрано»
      const id = attr(tag, 'id');
      let name = '';
      if (id) {
        const esc = id.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
        const m = new RegExp('for="' + esc + '"[^>]*>\\s*([^<]{1,200})').exec(part);
        name = m ? clean(m[1] ?? '') : '';
      }
      const [pageRaw, offerRaw] = value.split('_');
      const price = Number(attr(tag, 'data-price') ?? '0');
      out.push({
        group,
        name,
        pageId: Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : null,
        offerId: Number.isFinite(Number(offerRaw)) ? Number(offerRaw) : null,
        price: Number.isFinite(price) ? price : 0,
      });
    }
  }
  return out;
}

/** Группа, под которой в связке лежат размеры полотна с ценой (не комплектующее). */
export const CANVAS_GROUP = 'Размер полотна';

/** Размер «2000*800», «800х2000», «2000 x 800» -> высота и ширина, мм (большее число - высота). */
export function parseSize(s: string): { heightMm: number; widthMm: number } | null {
  const m = /(\d{3,4})\s*[*xх×X]\s*(\d{3,4})/.exec(s);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return { heightMm: Math.max(a, b), widthMm: Math.min(a, b) };
}

/**
 * Цены полотна по размерам из торговых предложений карточки:
 * gsSite.forms.emarket.tradeOffers.init(<pageId>, {"<offerId>": {..., "priceInfo": {"actual": 14190},
 * "subnodes:characteristicsList": [{"name": "razmer_polotna_fto", "value": "2000*600"}]}}).
 * Пустой массив - у двери нет выбора размера (цена одна, из каталога).
 */
export function parseCanvasSizes(html: string): DoorComponent[] {
  const at = html.indexOf('tradeOffers.init(');
  if (at < 0) return [];
  const start = html.indexOf('{', at);
  if (start < 0) return [];
  // Объект JSON по балансу скобок (строки учитываем, чтобы скобки в названиях не сбивали счёт).
  let depth = 0;
  let inStr = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(html.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: DoorComponent[] = [];
  const seen = new Set<string>();
  for (const [key, raw] of Object.entries(data)) {
    const o = raw as {
      priceInfo?: { actual?: unknown };
      'subnodes:characteristicsList'?: { name?: unknown; value?: unknown }[];
    };
    const ch = (o['subnodes:characteristicsList'] ?? []).find((c) => c.name === 'razmer_polotna_fto');
    const value = typeof ch?.value === 'string' ? clean(ch.value) : '';
    const price = Number(o.priceInfo?.actual);
    if (!value || !parseSize(value) || !Number.isFinite(price) || price <= 0 || seen.has(value)) continue;
    seen.add(value);
    out.push({ group: CANVAS_GROUP, name: value, pageId: null, offerId: Number.isFinite(Number(key)) ? Number(key) : null, price });
  }
  return out;
}

/** Комплектующие и размеры полотна с ценами - всё, что агенту нужно из карточки для расчёта. */
export function parseDoorCard(html: string): DoorComponent[] {
  return [...parseCanvasSizes(html), ...parseDoorComponents(html)];
}

/** Скачивает карточку и разбирает. Referer ставим свой - у антибота пустой referer уходит на проверку. */
export async function fetchDoorComponents(
  url: string,
  f: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<DoorComponent[]> {
  const res = await f(url, {
    headers: {
      'User-Agent': 'ai-door-agent/1.0 (+https://ai.rf-dveri.ru)',
      Referer: 'https://www.rf-dveri.ru/',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('Карточка ' + url + ': HTTP ' + String(res.status));
  return parseDoorCard(await res.text());
}
