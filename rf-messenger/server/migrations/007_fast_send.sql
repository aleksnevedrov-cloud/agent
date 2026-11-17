-- Скорость и безотказность отправки (ТЗ от 17.11.2026).
-- sent_at — момент фактической отправки в мессенджер (для замера «принято → отправлено»).
ALTER TABLE messages ADD COLUMN sent_at timestamptz;
-- Вложение входящего передаётся в amo отдельным сообщением после скачивания (текст уходит сразу).
ALTER TABLE messages ADD COLUMN amojo_media_msgid text;
-- Исходящие из окна/раздела до отправки: external_id появляется после отправки.
CREATE INDEX messages_out_pending ON messages (chat_id, id) WHERE direction = 'out' AND status = 'queued';
CREATE INDEX messages_out_stats ON messages (account_id, updated_at) WHERE direction = 'out';
