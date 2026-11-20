-- RFD-SITE-CHAT-AGENT, дополнение 20.11.2026: ответы менеджера из amoCRM в окно сайта и признак присутствия клиента.
-- Только ADD: прежний код этих колонок не читает.
ALTER TABLE site_chat_sessions ADD COLUMN IF NOT EXISTS seen_at timestamptz;             -- окно на связи (SSE-пинг или опрос); NULL — ещё не подключалось
ALTER TABLE site_chat_sessions ADD COLUMN IF NOT EXISTS presence_noted text;             -- что записано в заявку последним: offline / online
ALTER TABLE site_chat_sessions ADD COLUMN IF NOT EXISTS notes_checked_at timestamptz;    -- примечания менеджера прочитаны до этого момента
ALTER TABLE site_chat_messages ADD COLUMN IF NOT EXISTS author_name text;                -- имя менеджера для author = manager
CREATE INDEX IF NOT EXISTS site_chat_sessions_live ON site_chat_sessions (last_seen_at) WHERE amo_lead_id IS NOT NULL AND state IN ('active', 'handed_off');
