import { describe, expect, it } from 'vitest';
import { AmoApiClient } from '../src/client.ts';
import { mockFetch } from './helpers.ts';

const contact = (id: number, phone: string, email?: string) => ({
  id,
  name: `К${id}`,
  custom_fields_values: [
    { field_code: 'PHONE', field_name: 'Телефон', values: [{ value: phone }] },
    ...(email ? [{ field_code: 'EMAIL', field_name: 'Email', values: [{ value: email }] }] : []),
  ],
});

describe('amo API для чата сайта (RFD-SITE-CHAT-AGENT)', () => {
  it('контакт по телефону: совпадение по последним 10 цифрам, 8 и +7 — один контакт', async () => {
    const { fn, calls } = mockFetch((url) => {
      if (url.includes('/api/v4/contacts?')) return { status: 200, body: { _embedded: { contacts: [contact(1, '+7 (926) 123-45-67'), contact(2, '8 (926) 999-00-00')] } } };
      return { status: 404, body: {} };
    });
    const api = new AmoApiClient('acc.amocrm.ru', async () => 'T', fn);
    const found = await api.findContactsByPhone('89261234567');
    expect(found.map((c) => c.id)).toEqual([1]);
    expect(calls[0]?.url).toContain('query=9261234567');
    expect(await api.findContactsByPhone('123')).toEqual([]);
  });

  it('заявка в «Неразобранном»: форма с контактом по id и с новым контактом; примечание обновляется PATCH', async () => {
    const { fn, calls } = mockFetch((url, init) => {
      if (url.endsWith('/api/v4/leads/unsorted/forms')) {
        return { status: 200, body: { _embedded: { unsorted: [{ uid: 'u-123', _embedded: { leads: [{ id: 555 }], contacts: [{ id: 77 }] } }] } } };
      }
      if (url.endsWith('/api/v4/leads/555/notes/9') && init?.method === 'PATCH') return { status: 200, body: {} };
      return { status: 404, body: {} };
    });
    const api = new AmoApiClient('acc.amocrm.ru', async () => 'T', fn);
    const sentAt = new Date('2026-11-19T10:00:00Z');
    const r = await api.createUnsortedForm({
      sourceName: 'Чат на сайте rf-dveri.ru',
      sourceUid: 'site-chat',
      pipelineId: 1873498,
      leadName: 'Чат с сайта: Павел — дверь-книжка',
      tag: 'Чат сайта',
      contact: { name: 'Павел', phone: '79261234567', email: 'p@example.com' },
      metadata: { formId: 'site-chat', formName: 'Чат на сайте', formPage: 'https://www.rf-dveri.ru/x', referer: 'https://ya.ru', ip: '1.2.3.4', sentAt },
    });
    expect(r).toEqual({ uid: 'u-123', leadId: 555, contactId: 77 });
    const body = JSON.parse(String(calls[0]?.init?.body))[0];
    expect(body).toMatchObject({
      source_uid: 'site-chat',
      pipeline_id: 1873498,
      created_at: Math.floor(sentAt.getTime() / 1000),
      metadata: { form_id: 'site-chat', form_page: 'https://www.rf-dveri.ru/x', referer: 'https://ya.ru', ip: '1.2.3.4' },
    });
    expect(body._embedded.leads[0]).toMatchObject({ name: 'Чат с сайта: Павел — дверь-книжка', _embedded: { tags: [{ name: 'Чат сайта' }] } });
    expect(body._embedded.contacts[0].custom_fields_values).toEqual([
      { field_code: 'PHONE', values: [{ value: '+79261234567', enum_code: 'WORK' }] },
      { field_code: 'EMAIL', values: [{ value: 'p@example.com', enum_code: 'WORK' }] },
    ]);

    await api.createUnsortedForm({ sourceName: 's', sourceUid: 'site-chat', pipelineId: 1, leadName: 'x', contact: { id: 77 }, metadata: { formId: 'f', formName: 'n', formPage: 'p', sentAt } });
    expect(JSON.parse(String(calls[1]?.init?.body))[0]._embedded.contacts).toEqual([{ id: 77 }]);

    await api.updateLeadNote(555, 9, 'Сводка');
    expect(calls[2]).toMatchObject({ url: 'https://acc.amocrm.ru/api/v4/leads/555/notes/9' });
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ note_type: 'common', params: { text: 'Сводка' } });
  });

  it('дописать контакту почту и телефон, не стирая старые; ничего нового — без запроса', async () => {
    const { fn, calls } = mockFetch((url, init) => {
      if (url.endsWith('/api/v4/contacts/77') && (!init?.method || init.method === 'GET')) return { status: 200, body: contact(77, '+79261234567', 'old@example.com') };
      if (url.endsWith('/api/v4/contacts/77') && init?.method === 'PATCH') return { status: 200, body: {} };
      return { status: 404, body: {} };
    });
    const api = new AmoApiClient('acc.amocrm.ru', async () => 'T', fn);
    expect(await api.addContactFields(77, { phone: '89261234567', email: 'old@example.com' })).toBe(false);
    expect(calls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(0);
    expect(await api.addContactFields(77, { phone: '79990000000', email: 'new@example.com' })).toBe(true);
    const patch = JSON.parse(String(calls.find((c) => c.init?.method === 'PATCH')?.init?.body));
    expect(patch.custom_fields_values).toEqual([
      { field_code: 'PHONE', values: [{ value: '+79261234567', enum_code: 'WORK' }, { value: '+79990000000', enum_code: 'WORK' }] },
      { field_code: 'EMAIL', values: [{ value: 'old@example.com', enum_code: 'WORK' }, { value: 'new@example.com', enum_code: 'WORK' }] },
    ]);
  });
});
