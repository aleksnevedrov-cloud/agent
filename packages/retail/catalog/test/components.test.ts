import { describe, expect, it } from 'vitest';
import { parseDoorComponents } from '../src/components.ts';

/** Фрагмент карточки rf-dveri.ru: две группы комплектующих. */
const html = [
  '<div class="ComponentsInTheFormOfTradeOffers">',
  '<div class="Title FBB_CA">Коробка:</div>',
  '<input type="radio" name="ComponentInTheFormOfTradeOffer1" id="k0" value="" data-price="0">',
  '<label for="k0">не выбрано</label>',
  '<input type="radio" name="ComponentInTheFormOfTradeOffer1" id="k1" value="91234_5678" data-price="1156">',
  '<label for="k1">Стандартная 2080x70x26</label>',
  '</div>',
  '<div class="ComponentsInTheFormOfTradeOffers">',
  '<div class="Title FBB_CA">Наличник:</div>',
  '<input type="radio" name="ComponentInTheFormOfTradeOffer2" id="n0" value="" data-price="0">',
  '<label for="n0">не выбрано</label>',
  '<input type="radio" name="ComponentInTheFormOfTradeOffer2" id="n1" value="91235_5679" data-price="390">',
  '<label for="n1">Прямой 2150x70x8</label>',
  '</div>',
].join('\n');

describe('разбор комплектующих из карточки двери', () => {
  const items = parseDoorComponents(html);

  it('берёт все группы и пропускает вариант «не выбрано»', () => {
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.group)).toEqual(['Коробка', 'Наличник']);
  });

  it('читает название и цену варианта', () => {
    const korobka = items.find((i) => i.group === 'Коробка');
    expect(korobka?.name).toBe('Стандартная 2080x70x26');
    expect(korobka?.price).toBe(1156);
    expect(korobka?.pageId).toBe(91234);
    expect(korobka?.offerId).toBe(5678);
  });

  it('нет блока — пустой список, это не ошибка', () => {
    expect(parseDoorComponents('<html><body>без комплектующих</body></html>')).toEqual([]);
  });
});

/** Фрагмент карточки: торговые предложения с размерами полотна (как на rf-dveri.ru, Честер ПО 99415). */
const offersHtml =
  '<script> $(document).ready(function(){ gsSite.forms.emarket.tradeOffers.init(99415, ' +
  JSON.stringify({
    '443751': { 'attribute:id': 443751, name: 'Честер ПО (размер полотна: 2000*600)', priceInfo: { actual: 14190 }, characteristics: { razmer_polotna_fto: '922' }, 'subnodes:characteristicsList': [{ name: 'razmer_polotna_fto', title: 'Размер полотна', value: '2000*600' }] },
    '443752': { 'attribute:id': 443752, name: 'Честер ПО {скобка} (размер полотна: 2000*800)', priceInfo: { actual: 14190 }, characteristics: { razmer_polotna_fto: '924' }, 'subnodes:characteristicsList': [{ name: 'razmer_polotna_fto', title: 'Размер полотна', value: '2000*800' }] },
    '443753': { 'attribute:id': 443753, name: 'Честер ПО (размер полотна: 2600*800)', priceInfo: { actual: 21500 }, characteristics: { razmer_polotna_fto: '930' }, 'subnodes:characteristicsList': [{ name: 'razmer_polotna_fto', title: 'Размер полотна', value: '2600*800' }] },
  }) +
  ', {}); });</script>';

describe('размеры полотна из торговых предложений карточки', () => {
  it('берёт размер и цену каждого предложения', async () => {
    const { parseCanvasSizes, CANVAS_GROUP } = await import('../src/components.ts');
    const sizes = parseCanvasSizes(offersHtml);
    expect(sizes.map((s) => [s.name, s.price])).toEqual([
      ['2000*600', 14190],
      ['2000*800', 14190],
      ['2600*800', 21500],
    ]);
    expect(sizes.every((s) => s.group === CANVAS_GROUP && s.offerId !== null)).toBe(true);
  });

  it('карточка без предложений — пусто, комплектующие разбираются как раньше', async () => {
    const { parseCanvasSizes, parseDoorCard } = await import('../src/components.ts');
    expect(parseCanvasSizes(html)).toEqual([]);
    expect(parseDoorCard(html + offersHtml)).toHaveLength(5);
  });

  it('размер читается в любом порядке и с русской «х»', async () => {
    const { parseSize } = await import('../src/components.ts');
    expect(parseSize('2000*800')).toEqual({ heightMm: 2000, widthMm: 800 });
    expect(parseSize('800х2600')).toEqual({ heightMm: 2600, widthMm: 800 });
    expect(parseSize('без размера')).toBeNull();
  });
});
