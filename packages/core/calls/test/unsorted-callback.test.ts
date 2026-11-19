// RFD-AI-AGENT-UNSORTED-CALLBACK: пропущенный в «Неразобранном» → менеджер перезвонил → заявка принята на него,
// ответственный сделки и контакта — звонивший. amoCRM — поддельный AmoRaw, БД не нужна.
import { widgetSettingsSchema, type JournalEntry } from '@core/db';
import { describe, expect, it } from 'vitest';
import { firstCallback, runUnsortedCallback, type AmoCallNote, type AmoRaw, type UnsortedCallbackDeps } from '../src/index.ts';

const T0 = 1_795_074_124;
const VADIM = 10_406_082;

const callOut = (id: number, at: number, by: number, status = 4, duration = 24): AmoCallNote => ({ id, entity_id: 66, created_by: by, created_at: at, updated_at: at, responsible_user_id: by, note_type: 'call_out', params: { call_status: status, duration } });

function fakeAmo(notesByPath: Record<string, AmoCallNote[]>, unsorted: unknown[]) {
  const posts: { path: string; body: unknown }[] = [];
  const patches: { path: string; body: unknown }[] = [];
  const amo: AmoRaw = {
    get: async <T>(path: string) => {
      if (path.startsWith('/api/v4/leads/unsorted?')) return { _embedded: { unsorted } } as T;
      const key = Object.keys(notesByPath).find((k) => path.startsWith(k));
      return (key ? { _embedded: { notes: notesByPath[key] } } : null) as T;
    },
    post: async <T>(path: string, body: unknown) => {
      posts.push({ path, body });
      return { _embedded: { leads: [{ id: 30068298 }], contacts: [{ id: 66 }] } } as T;
    },
    patch: async <T>(path: string, body: unknown) => {
      patches.push({ path, body });
      return null as T;
    },
  };
  return { amo, posts, patches };
}

function deps(over: Record<string, unknown> = {}) {
  const journal: JournalEntry[] = [];
  const d: UnsortedCallbackDeps = {
    journal: { add: async (e: JournalEntry) => void journal.push(e) } as never,
    accounts: { get: async () => ({ accountDomain: 'x.amocrm.ru', uninstalledAt: null }) } as never,
    tokenService: { getAccessToken: async () => 't' },
    fetch: (async () => new Response(null, { status: 204 })) as typeof fetch,
    settingsFor: async () => widgetSettingsSchema.parse({ unsortedCallback: over }),
    accountIds: async () => [1],
  };
  return { d, journal };
}

const ITEM = { uid: 'u1', category: 'sip', created_at: T0, _embedded: { leads: [{ id: 30068298 }], contacts: [{ id: 66 }] } };

describe('перезвон по пропущенному в «Неразобранном»', () => {
  it('исходящий звонок менеджера в контакт → заявка принята от его имени, ответственный сделки и контакта — он', async () => {
    const { amo, posts, patches } = fakeAmo({ '/api/v4/contacts/66/notes': [callOut(1, T0 + 147, VADIM)] }, [ITEM]);
    const { d, journal } = deps();
    const r = await runUnsortedCallback(d, 1, { amo });
    expect(r.accepted).toEqual([{ uid: 'u1', leadId: 30068298, userId: VADIM }]);
    expect(posts).toEqual([{ path: '/api/v4/leads/unsorted/u1/accept', body: { user_id: VADIM } }]);
    expect(patches).toEqual([
      { path: '/api/v4/leads', body: [{ id: 30068298, responsible_user_id: VADIM }] },
      { path: '/api/v4/contacts', body: [{ id: 66, responsible_user_id: VADIM }] },
    ]);
    expect(journal[0]).toMatchObject({ kind: 'unsorted_callback', leadId: 30068298 });
  });

  it('звонка нет, звонок до заявки или от робота — заявка остаётся в «Неразобранном»', async () => {
    const { amo, posts } = fakeAmo({ '/api/v4/contacts/66/notes': [callOut(1, T0 - 60, VADIM), callOut(2, T0 + 60, 0)] }, [ITEM, { ...ITEM, uid: 'u2', _embedded: { contacts: [{ id: 77 }] } }]);
    const { d } = deps();
    const r = await runUnsortedCallback(d, 1, { amo });
    expect([r.checked, r.accepted.length, posts.length]).toEqual([2, 0, 0]);
  });

  it('onlyTalked: «не дозвонился» не считается, «разговор состоялся» — да; выбирается первый перезвонивший', () => {
    const notes = [callOut(3, T0 + 300, 777, 4), callOut(2, T0 + 100, VADIM, 6, 0)];
    expect(firstCallback(notes, T0, true)?.userId).toBe(777);
    expect(firstCallback(notes, T0, false)?.userId).toBe(VADIM);
  });

  it('выключено в настройках — amo не опрашивается', async () => {
    const { amo, posts } = fakeAmo({}, [ITEM]);
    const { d } = deps({ enabled: false });
    const r = await runUnsortedCallback(d, 1, { amo });
    expect([r.enabled, r.checked, posts.length]).toEqual([false, 0, 0]);
  });

  it('по умолчанию: включено, воронка «Двери», любой исходящий звонок', () => {
    expect(widgetSettingsSchema.parse({}).unsortedCallback).toEqual({ enabled: true, pipelineId: 1873498, onlyTalked: false });
  });
});
