import { useCallback, useEffect, useState } from 'react';
import type { SiteChatSessionRow, SiteChatTranscript, WidgetApi } from '../api.ts';
import { dateTime, rub } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { errorMessage } from './useLoad.ts';

const STATE_LABEL: Record<string, string> = { active: 'идёт', handed_off: 'передан менеджеру', closed: 'закрыт', spam: 'спам' };
const SYNC_LABEL: Record<string, string> = { pending: 'ждёт записи', sent: 'в amoCRM', failed: 'не записан' };
const REASON_LABEL: Record<string, string> = { client_request: 'просит менеджера', complaint: 'жалоба', callback: 'заказ звонка', manager: 'ответил менеджер', limit: 'лимит ответов', llm_error: 'сбой модели' };
const AUTHOR: Record<string, string> = { client: 'Клиент', agent: 'Амма', system: 'Система', manager: 'Менеджер' };
const FILTERS = [
  ['', 'Все диалоги'],
  ['active', 'Идут'],
  ['handed_off', 'Переданы менеджеру'],
  ['closed', 'Закрыты'],
  ['failed', 'Не записаны в amoCRM'],
] as const;

/**
 * RFD-SITE-CHAT-AGENT: вкладка «Диалоги сайта» — журнал переписки с сайта (предложение заказчика 20.11.2026).
 * Список последних 100 диалогов, по клику — полная переписка с именами, карточками и стоимостью ответов.
 */
export function SiteChatDialogs({ api }: { api: WidgetApi }) {
  const [rows, setRows] = useState<SiteChatSessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<SiteChatTranscript | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows((await api.siteChatSessions()).sessions);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [api]);
  useEffect(() => void load(), [load]);

  const open = async (id: string) => {
    if (openId === id) {
      setOpenId(null);
      setTranscript(null);
      return;
    }
    setOpenId(id);
    setTranscript(null);
    try {
      setTranscript(await api.siteChatSession(id));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const q = query.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => {
    if (filter === 'failed' ? r.amoSync !== 'failed' : filter && r.state !== filter) return false;
    if (!q) return true;
    return [r.name, r.phone, r.email, String(r.amoLeadId ?? '')].some((v) => v.toLowerCase().includes(q));
  });

  return (
    <div style={s.col}>
      <div style={s.row}>
        <select style={s.select} value={filter} onChange={(e) => setFilter(e.target.value as (typeof FILTERS)[number][0])}>
          {FILTERS.map(([v, name]) => (
            <option key={v} value={v}>
              {name}
            </option>
          ))}
        </select>
        <input style={{ ...s.input, width: 220 }} placeholder="Имя, телефон, почта или № заявки" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" style={s.buttonGhost} onClick={() => void load()}>
          Обновить
        </button>
        {rows && <span style={s.muted}>{shown.length} из {rows.length}</span>}
      </div>
      {error && <div style={s.error}>{error}</div>}
      {rows === null && !error && <div style={s.muted}>Загрузка…</div>}
      {rows && rows.length === 0 && <div style={s.muted}>Диалогов с сайта ещё не было.</div>}
      {shown.map((r) => (
        <div key={r.id} style={{ ...s.block, ...s.small }}>
          <div style={{ ...s.row, cursor: 'pointer' }} onClick={() => void open(r.id)} role="button" tabIndex={0}>
            <span style={s.muted}>{dateTime(r.createdAt)}</span>
            <b>
              {r.name}, +{r.phone}
            </b>
            {r.email && <span style={s.muted}>{r.email}</span>}
            <span>{r.messages} сообщ.</span>
            <span style={r.state === 'active' ? s.badgeOk : s.badgeWarn}>
              {STATE_LABEL[r.state] ?? r.state}
              {r.handoffReason ? ` · ${REASON_LABEL[r.handoffReason] ?? r.handoffReason}` : ''}
            </span>
            {r.online && <span style={s.badgeOk}>на сайте</span>}
            <span style={r.amoSync === 'failed' ? s.error : s.muted}>
              {SYNC_LABEL[r.amoSync] ?? r.amoSync}
              {r.amoLeadId ? ` #${r.amoLeadId}` : ''}
            </span>
            <span style={s.muted}>{openId === r.id ? '▲' : '▼'}</span>
          </div>
          {r.amoError && <div style={{ ...s.error, marginTop: 2 }}>{r.amoError}</div>}
          {openId === r.id && (
            <div style={{ ...s.card, marginTop: 8 }}>
              {!transcript && <div style={s.muted}>Загрузка переписки…</div>}
              {transcript && (
                <div style={s.col}>
                  <div style={s.muted}>
                    Страница: {transcript.session.pageTitle ?? '—'}
                    {transcript.session.pageUrl ? ` (${transcript.session.pageUrl})` : ''}
                    {Object.keys(transcript.session.utm ?? {}).length ? ` · UTM: ${Object.entries(transcript.session.utm).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}
                  </div>
                  {transcript.messages.map((m) => (
                    <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <span style={{ ...s.muted, minWidth: 40 }}>{dateTime(m.at).slice(-5)}</span>
                      <b style={{ minWidth: 70 }}>{m.author === 'manager' && m.authorName ? m.authorName : (AUTHOR[m.author] ?? m.author)}:</b>
                      <span style={{ whiteSpace: 'pre-wrap', flex: 1 }}>
                        {m.text}
                        {m.products.length > 0 && <span style={s.muted}> · карточки: {m.products.map((p) => `${p.name}${p.price ? ` ${rub(p.price)}` : ''}`).join('; ')}</span>}
                      </span>
                      {m.costRub > 0 && <span style={s.muted}>{rub(m.costRub)}</span>}
                    </div>
                  ))}
                  {transcript.session.summaryText && (
                    <div style={{ ...s.small, whiteSpace: 'pre-wrap', borderTop: '1px solid #E1E5E9', paddingTop: 6 }}>
                      <b>Сводка Аммы:</b> {transcript.session.summaryText}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
