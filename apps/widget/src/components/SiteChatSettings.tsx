import { useCallback } from 'react';
import type { SiteChatOverview, WidgetApi, WidgetSettings } from '../api.ts';
import { Field, linesToList, NumberInput } from './fields.tsx';
import { dateTime, rub } from './StatusBadge.tsx';
import { s } from './styles.ts';
import { useLoad } from './useLoad.ts';

type SC = WidgetSettings['siteChat'];

const STATE_LABEL: Record<string, string> = { active: 'идёт', handed_off: 'передан менеджеру', closed: 'закрыт', spam: 'спам' };
const SYNC_LABEL: Record<string, string> = { pending: 'ждёт записи', sent: 'в amoCRM', failed: 'не записан' };

/**
 * RFD-SITE-CHAT-AGENT: вкладка «Чат сайта» — чат на rf-dveri.ru вместо Jivo на базе агента розницы.
 * Меняет только администратор аккаунта (как и остальные настройки). Окно читает их из GET /site-chat/v1/config.
 */
export function SiteChatSettings({ api, value, onChange }: { api: WidgetApi; value: SC; onChange: (patch: Partial<SC>) => void }) {
  const load = useCallback(() => api.siteChatOverview(), [api]);
  const [state] = useLoad(load);
  const setPopup = (patch: Partial<SC['popup']>) => onChange({ popup: { ...value.popup, ...patch } });

  return (
    <>
      <Field label="Чат на сайте" hint="Включает окно чата на rf-dveri.ru. Заявка в «Неразобранном» создаётся на первом сообщении, независимо от агента.">
        <label style={s.row}>
          <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
          Чат на сайте включён
        </label>
        <label style={s.row}>
          <input type="checkbox" checked={value.agentEnabled} onChange={(e) => onChange({ agentEnabled: e.target.checked })} />
          Агент отвечает в чате (выкл. — только автоответ и заявка)
        </label>
      </Field>

      {state.status === 'ready' && (
        <Field label="Подключение на сайте" hint="Одну строку поставить в шаблон UMI (ставит заказчик). Демо-страница — для проверки, на сайт не ставится.">
          <input style={s.input} readOnly value={state.data.scriptTag} onFocus={(e) => e.currentTarget.select()} />
          <div style={{ ...s.small, marginTop: 4 }}>
            <a href={state.data.demoUrl} target="_blank" rel="noreferrer">
              Открыть демо-страницу
            </a>
            {' · '}Расход канала сегодня: {rub(state.data.costTodayRub)} из {rub(state.data.dailyBudgetRub)}
          </div>
        </Field>
      )}

      <Field label="Часы ответов агента (МСК)" hint="Оба поля пустые — круглосуточно. Вне часов в окне только автоответ, заявка создаётся как обычно.">
        <div style={s.row}>
          <input style={{ ...s.input, width: 90 }} placeholder="10:00" value={value.hoursFrom ?? ''} onChange={(e) => onChange({ hoursFrom: e.target.value.trim() || null })} />
          <span>—</span>
          <input style={{ ...s.input, width: 90 }} placeholder="20:00" value={value.hoursTo ?? ''} onChange={(e) => onChange({ hoursTo: e.target.value.trim() || null })} />
        </div>
        <input style={{ ...s.input, marginTop: 6 }} placeholder="Текст вне часов" value={value.offHoursText} onChange={(e) => onChange({ offHoursText: e.target.value })} />
      </Field>

      <Field label="Тексты окна">
        <div style={s.col}>
          <input style={s.input} placeholder="Первое сообщение агента" value={value.greeting} onChange={(e) => onChange({ greeting: e.target.value })} />
          <input style={s.input} placeholder="Автоответ без агента" value={value.autoReply} onChange={(e) => onChange({ autoReply: e.target.value })} />
          <input style={s.input} placeholder="Фраза при передаче менеджеру ({phone} — телефон клиента)" value={value.handoffText} onChange={(e) => onChange({ handoffText: e.target.value })} />
          <input style={s.input} placeholder="Ответ после передачи менеджеру" value={value.afterHandoffText} onChange={(e) => onChange({ afterHandoffText: e.target.value })} />
          <input style={s.input} placeholder="Ссылка на политику конфиденциальности" value={value.privacyUrl} onChange={(e) => onChange({ privacyUrl: e.target.value })} />
          <input style={s.input} placeholder="Телефон в сообщении об ошибке отправки" value={value.fallbackPhone} onChange={(e) => onChange({ fallbackPhone: e.target.value })} />
        </div>
      </Field>

      <Field label="Связаться с нами (телефон)" hint="Шторка на телефоне по макету сайта: онлайн-чат и ссылки на мессенджеры. Пустая ссылка — строки нет. Только https://wa.me/…, https://t.me/…, https://max.ru/…">
        <div style={s.col}>
          <input style={s.input} placeholder="WhatsApp: https://wa.me/74955324941" value={value.contacts.whatsapp} onChange={(e) => onChange({ contacts: { ...value.contacts, whatsapp: e.target.value.trim() } })} />
          <input style={s.input} placeholder="Telegram: https://t.me/…" value={value.contacts.telegram} onChange={(e) => onChange({ contacts: { ...value.contacts, telegram: e.target.value.trim() } })} />
          <input style={s.input} placeholder="MAX: https://max.ru/…" value={value.contacts.max} onChange={(e) => onChange({ contacts: { ...value.contacts, max: e.target.value.trim() } })} />
          <input style={s.input} placeholder="Почта для «Написать на почту»" value={value.contacts.email} onChange={(e) => onChange({ contacts: { ...value.contacts, email: e.target.value.trim() } })} />
        </div>
      </Field>

      <Field label="Правила канала «чат сайта»" hint="Добавляются к общим правилам агента. До 4 000 символов.">
        <textarea style={{ ...s.textarea, minHeight: 160 }} value={value.rules} onChange={(e) => onChange({ rules: e.target.value.slice(0, 4000) })} />
      </Field>

      <Field label="Всплывание окна" hint="Перенести из настроек приглашений Jivo: задержка, текст, страницы (подстрока адреса или шаблон с * в конце; пусто — все страницы).">
        <label style={s.row}>
          <input type="checkbox" checked={value.popup.enabled} onChange={(e) => setPopup({ enabled: e.target.checked })} />
          Открывать окно самому
        </label>
        <div style={s.row}>
          <span>через</span>
          <NumberInput value={value.popup.delaySec} min={0} max={600} onChange={(x) => setPopup({ delaySec: x ?? 0 })} />
          <span>с</span>
          <label style={s.row}>
            <input type="checkbox" checked={value.popup.mobile} onChange={(e) => setPopup({ mobile: e.target.checked })} />
            и на телефонах
          </label>
        </div>
        <input style={{ ...s.input, marginTop: 6 }} placeholder="Текст приглашения" value={value.popup.text} onChange={(e) => setPopup({ text: e.target.value })} />
        <textarea style={{ ...s.textarea, minHeight: 60, marginTop: 6 }} placeholder={'Страницы, по одной в строке: /catalog/*'} value={value.popup.pages.join('\n')} onChange={(e) => setPopup({ pages: linesToList(e.target.value) })} />
      </Field>

      <Field label="Лимиты и запись в amoCRM">
        <div style={s.row}>
          <span>Ответов агента в одной сессии</span>
          <NumberInput value={value.maxRepliesPerSession} min={1} max={200} onChange={(x) => onChange({ maxRepliesPerSession: x ?? 20 })} />
        </div>
        <div style={s.row}>
          <span>Бюджет канала в сутки, ₽</span>
          <NumberInput value={value.dailyBudgetRub} min={0} onChange={(x) => onChange({ dailyBudgetRub: x ?? 0 })} />
        </div>
        <div style={s.row}>
          <span>Закрывать диалог через, мин без сообщений</span>
          <NumberInput value={value.idleCloseMin} min={1} max={240} onChange={(x) => onChange({ idleCloseMin: x ?? 10 })} />
        </div>
        <div style={s.row}>
          <span>Воронка (id)</span>
          <NumberInput value={value.pipelineId} min={1} onChange={(x) => onChange({ pipelineId: x ?? 1873498 })} />
          <input style={{ ...s.input, width: 160 }} placeholder="Тег" value={value.tag} onChange={(e) => onChange({ tag: e.target.value })} />
        </div>
        <input style={{ ...s.input, marginTop: 6 }} placeholder="Источник заявки" value={value.sourceName} onChange={(e) => onChange({ sourceName: e.target.value })} />
      </Field>

      <Field label="Последние диалоги с сайта">
        {state.status === 'loading' && <div style={s.muted}>Загрузка…</div>}
        {state.status === 'error' && <div style={s.error}>{state.message}</div>}
        {state.status === 'ready' && !state.data.sessions.length && <div style={s.muted}>Диалогов ещё не было.</div>}
        {state.status === 'ready' && state.data.sessions.length > 0 && (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={s.muted}>
                <th style={{ textAlign: 'left' }}>Когда</th>
                <th style={{ textAlign: 'left' }}>Клиент</th>
                <th style={{ textAlign: 'left' }}>Сообщений</th>
                <th style={{ textAlign: 'left' }}>Диалог</th>
                <th style={{ textAlign: 'left' }}>Заявка</th>
              </tr>
            </thead>
            <tbody>
              {state.data.sessions.map((x: SiteChatOverview['sessions'][number]) => (
                <tr key={x.id}>
                  <td>{dateTime(x.createdAt)}</td>
                  <td>
                    {x.name}, +{x.phone}
                  </td>
                  <td>{x.messages}</td>
                  <td>{STATE_LABEL[x.state] ?? x.state}</td>
                  <td style={x.amoSync === 'failed' ? s.error : undefined}>
                    {SYNC_LABEL[x.amoSync] ?? x.amoSync}
                    {x.amoLeadId ? ` #${x.amoLeadId}` : ''}
                    {x.amoError ? ` — ${x.amoError}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Field>
    </>
  );
}
