-- Задание от 20.11.2026 (кнопка «Онлайн-чат», цели Метрики): yclid Яндекс Директа из cookie сайта rfd_yclid.
-- Только ADD: прежний код колонку не читает.
ALTER TABLE site_chat_sessions ADD COLUMN IF NOT EXISTS yclid text;
