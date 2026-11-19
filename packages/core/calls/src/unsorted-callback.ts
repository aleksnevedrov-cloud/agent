import type { JournalKind } from '@core/db';
import type { CallsDeps } from './deps.ts';
import { amoRaw, type AmoCallNote, type AmoRaw } from './notes.ts';

/**
 * RFD-AI-AGENT-UNSORTED-CALLBACK. Пропущенный звонок с неизвестного номера ВАТС кладёт в «Неразобранное» — заявка ничья.
 * Когда менеджер перезвонил, ВАТС пишет исходящий звонок (call_out) в контакт заявки, но заявку не трогает.
 * Задание раз в 2 минуты: заявки-звонки (category sip) в «Неразобранном» воронки → исходящий звонок менеджера в контакт
 * или сделку заявки после её создания → заявка принимается (POST /leads/unsorted/{uid}/accept) от имени этого менеджера,
 * ответственный сделки и контакта — он же. Дубля нет: принимается та же заявка, новая сделка не создаётся.
 */

export const UNSORTED_CALLBACK_JOB = 'unsorted-callback';
export const UNSORTED_CALLBACK_EVERY_MS = 2 * 60_000;
export const UNSORTED_CALLBACK_KIND: JournalKind = 'unsorted_callback';
export const UNSORTED_CALLBACK_ERROR_KIND: JournalKind = 'unsorted_callback_error';

/** call_status amo: 4 — «Разговор состоялся». */
const CALL_STATUS_TALKED = 4;
const UNSORTED_PAGE = 250;
const MAX_PAGES = 4;

export type UnsortedCallbackDeps = Pick<CallsDeps, 'journal' | 'accounts' | 'tokenService' | 'fetch' | 'settingsFor' | 'accountIds'>;

export interface UnsortedItem {
  uid: string;
  category: string;
  pipeline_id?: number;
  created_at: number;
  _embedded?: { leads?: { id: number }[]; contacts?: { id: number }[] };
}

export interface UnsortedCallbackResult {
  accountId: number;
  enabled: boolean;
  checked: number;
  accepted: { uid: string; leadId: number; userId: number }[];
  errors: string[];
}

export interface UnsortedCallbackOptions {
  amo?: AmoRaw;
}

/** Заявки-звонки «Неразобранного» воронки (до 1 000). */
export async function listSipUnsorted(amo: AmoRaw, pipelineId: number): Promise<UnsortedItem[]> {
  const out: UnsortedItem[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await amo.get<{ _embedded?: { unsorted?: UnsortedItem[] } }>(`/api/v4/leads/unsorted?filter[pipeline_id]=${pipelineId}&filter[category][]=sip&limit=${UNSORTED_PAGE}&page=${page}`);
    const rows = res?._embedded?.unsorted ?? [];
    out.push(...rows.filter((r) => r.category === 'sip'));
    if (rows.length < UNSORTED_PAGE) break;
  }
  return out;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Кто звонил: менеджер ВАТС пишется в created_by (и в responsible_user_id) примечания; 0 — робот, не менеджер. */
export function callerOf(n: AmoCallNote): number | null {
  const id = num(n.created_by) || num(n.responsible_user_id);
  return id && id > 0 ? id : null;
}

/** Первый исходящий звонок менеджера не раньше createdAt (Unix-секунды); onlyTalked — только «Разговор состоялся». */
export function firstCallback(notes: AmoCallNote[], createdAt: number, onlyTalked: boolean): { note: AmoCallNote; userId: number } | null {
  const hits = notes
    .filter((n) => n.note_type === 'call_out' && n.created_at >= createdAt)
    .filter((n) => !onlyTalked || num(n.params?.call_status) === CALL_STATUS_TALKED)
    .map((n) => ({ note: n, userId: callerOf(n) }))
    .filter((h): h is { note: AmoCallNote; userId: number } => h.userId !== null)
    .sort((a, b) => a.note.created_at - b.note.created_at);
  return hits[0] ?? null;
}

async function outgoingCalls(amo: AmoRaw, entity: 'leads' | 'contacts', id: number, from: number): Promise<AmoCallNote[]> {
  const res = await amo.get<{ _embedded?: { notes?: AmoCallNote[] } }>(`/api/v4/${entity}/${id}/notes?filter[note_type][]=call_out&filter[updated_at][from]=${from}&limit=50`);
  return res?._embedded?.notes ?? [];
}

export async function runUnsortedCallbackAll(deps: UnsortedCallbackDeps, opts: UnsortedCallbackOptions = {}): Promise<UnsortedCallbackResult[]> {
  const out: UnsortedCallbackResult[] = [];
  for (const accountId of await deps.accountIds()) {
    try {
      out.push(await runUnsortedCallback(deps, accountId, opts));
    } catch (err) {
      const msg = (err as Error).message;
      out.push({ accountId, enabled: true, checked: 0, accepted: [], errors: [msg] });
      await deps.journal.add({ accountId, kind: UNSORTED_CALLBACK_ERROR_KIND, summary: `Неразобранное: проверка перезвонов не выполнена — ${msg}`, details: { error: msg } }).catch(() => undefined);
    }
  }
  return out;
}

/** Один аккаунт: заявки-звонки → исходящий звонок менеджера после заявки → принять от его имени, назначить ответственным. */
export async function runUnsortedCallback(deps: UnsortedCallbackDeps, accountId: number, opts: UnsortedCallbackOptions = {}): Promise<UnsortedCallbackResult> {
  const s = (await deps.settingsFor(accountId)).unsortedCallback;
  const r: UnsortedCallbackResult = { accountId, enabled: s.enabled, checked: 0, accepted: [], errors: [] };
  if (!s.enabled) return r;
  const account = await deps.accounts.get(accountId);
  if (!account || account.uninstalledAt) throw new Error(`Аккаунт ${accountId} не подключён`);
  const amo = opts.amo ?? amoRaw(account.accountDomain, () => deps.tokenService.getAccessToken(accountId), deps.fetch);

  for (const item of await listSipUnsorted(amo, s.pipelineId)) {
    r.checked++;
    const leadId = item._embedded?.leads?.[0]?.id ?? null;
    const contactIds = (item._embedded?.contacts ?? []).map((c) => c.id).slice(0, 3);
    try {
      const notes: AmoCallNote[] = [];
      for (const cid of contactIds) notes.push(...(await outgoingCalls(amo, 'contacts', cid, item.created_at)));
      if (leadId) notes.push(...(await outgoingCalls(amo, 'leads', leadId, item.created_at)));
      const hit = firstCallback(notes, item.created_at, s.onlyTalked);
      if (!hit) continue;

      const res = await amo.post<{ _embedded?: { leads?: { id: number }[]; contacts?: { id: number }[] } }>(`/api/v4/leads/unsorted/${encodeURIComponent(item.uid)}/accept`, { user_id: hit.userId });
      const acceptedLeads = (res?._embedded?.leads ?? []).map((l) => l.id);
      const acceptedContacts = (res?._embedded?.contacts ?? []).map((c) => c.id);
      const leads = acceptedLeads.length ? acceptedLeads : leadId ? [leadId] : [];
      const contacts = acceptedContacts.length ? acceptedContacts : contactIds;
      // accept назначает принявшего не во всех случаях — ответственного ставим явно.
      if (leads.length) await amo.patch('/api/v4/leads', leads.map((id) => ({ id, responsible_user_id: hit.userId })));
      if (contacts.length) await amo.patch('/api/v4/contacts', contacts.map((id) => ({ id, responsible_user_id: hit.userId })));

      const lead = leads[0] ?? 0;
      r.accepted.push({ uid: item.uid, leadId: lead, userId: hit.userId });
      await deps.journal.add({
        accountId,
        leadId: lead || null,
        kind: UNSORTED_CALLBACK_KIND,
        summary: `Неразобранное: заявка принята после перезвона, ответственный — пользователь ${hit.userId}`,
        details: { uid: item.uid, leadIds: leads, contactIds: contacts, userId: hit.userId, noteId: hit.note.id, callAt: hit.note.created_at, callStatus: num(hit.note.params?.call_status), durationSec: num(hit.note.params?.duration) },
      });
    } catch (err) {
      const msg = `заявка ${leadId ?? item.uid}: ${(err as Error).message}`;
      r.errors.push(msg);
      await deps.journal.add({ accountId, leadId, kind: UNSORTED_CALLBACK_ERROR_KIND, summary: `Неразобранное: ${msg}`, details: { uid: item.uid, error: (err as Error).message } }).catch(() => undefined);
    }
  }
  return r;
}
