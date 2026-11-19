-- RFD-SITE-CHAT-AGENT: чат на rf-dveri.ru на базе агента розницы.
-- Сессия = один клиент в окне сайта (форма с контактами); заявка в «Неразобранном» создаётся на первом сообщении.
-- Только добавление.
CREATE TABLE IF NOT EXISTS site_chat_sessions (
  id                text PRIMARY KEY,                 -- случайный, 128 бит, в localStorage клиента
  account_id        bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  name              text NOT NULL,
  phone             text NOT NULL,                    -- 7XXXXXXXXXX
  email             text NOT NULL,
  consent_at        timestamptz NOT NULL,
  page_url          text,
  page_title        text,
  referrer          text,
  utm               jsonb NOT NULL DEFAULT '{}'::jsonb,
  ym_uid            text,
  ga_cid            text,
  ip                text,
  user_agent        text,
  -- active → handed_off (передан менеджеру) / closed (ушёл, диалог закрыт) / spam.
  state             text NOT NULL DEFAULT 'active',
  handoff_reason    text,
  -- Запись в amoCRM: заявка в «Неразобранном» и созданные/найденные сущности.
  amo_unsorted_uid  text,
  amo_lead_id       bigint,
  amo_contact_id    bigint,
  amo_sync          text NOT NULL DEFAULT 'pending',  -- pending / sent / failed
  amo_attempts      smallint NOT NULL DEFAULT 0,
  amo_next_try_at   timestamptz NOT NULL DEFAULT now(),
  amo_error         text,
  -- Сводка Аммы (одно примечание, повторный вызов обновляет) и задача «Перезвонить клиенту с сайта».
  summary_text      text,
  summary_sync      text NOT NULL DEFAULT 'none',     -- none / pending / sent
  summary_note_id   bigint,
  task_sync         text NOT NULL DEFAULT 'none',     -- none / pending / sent
  task_id           bigint,
  closed_at         timestamptz
);
CREATE INDEX IF NOT EXISTS site_chat_sessions_sync ON site_chat_sessions (amo_next_try_at) WHERE amo_sync = 'pending' OR summary_sync = 'pending' OR task_sync = 'pending';
CREATE INDEX IF NOT EXISTS site_chat_sessions_active ON site_chat_sessions (account_id, last_seen_at) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS site_chat_sessions_ip ON site_chat_sessions (ip, created_at);
CREATE INDEX IF NOT EXISTS site_chat_sessions_phone ON site_chat_sessions (account_id, phone, created_at);

CREATE TABLE IF NOT EXISTS site_chat_messages (
  id              bigserial PRIMARY KEY,
  session_id      text NOT NULL REFERENCES site_chat_sessions(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  author          text NOT NULL,                      -- client / agent / system
  text            text NOT NULL,
  products        jsonb NOT NULL DEFAULT '[]'::jsonb, -- карточки товаров в ответе агента
  cost_rub        numeric(10,2) NOT NULL DEFAULT 0,
  -- Примечание в amoCRM: пачкой «вопрос → ответ», одно примечание на пару.
  amo_note_id     bigint,
  amo_sync        text NOT NULL DEFAULT 'pending'     -- pending / sent / failed / skipped
);
CREATE INDEX IF NOT EXISTS site_chat_messages_session ON site_chat_messages (session_id, id);
CREATE INDEX IF NOT EXISTS site_chat_messages_pending ON site_chat_messages (session_id) WHERE amo_sync = 'pending';
