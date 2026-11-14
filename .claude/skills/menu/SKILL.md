---
name: menu
description: Шпаргалка по навыкам и командам этого репозитория. Вызывать, когда пользователь набирает /menu, спрашивает «какие есть команды», «что умеешь», «как запустить проверку», или не помнит имя и аргументы навыка.
---

# /menu — шпаргалка по навыкам и командам

Покажи пользователю таблицы ниже как есть, на русском, без сокращений и без пересказа.
Если в `/menu` передан аргумент (например, `/menu ревью` или `/menu данные`), покажи только подходящие группы.
Ничего не запускай сам: это справка. После таблиц одной строкой предложи выполнить выбранный пункт.
Навыки с префиксом (`anthropic-skills:`, `data:`, `design:`) приходят из плагинов и могут отсутствовать в конкретной сессии; если навыка нет в списке доступных, скажи об этом.

## Проверка кода (перед каждым коммитом и PR)

| Команда | Что делает | Пример |
|---|---|---|
| `pnpm check` | Полная проверка: lint + поиск секретов + typecheck + тесты. Красное — не коммитить | `pnpm check` |
| `pnpm lint` | Только ESLint | `pnpm lint` |
| `pnpm secrets` | Поиск ключей и паролей в отслеживаемых файлах | `pnpm secrets` |
| `pnpm typecheck` | Только типы TypeScript во всех пакетах | `pnpm typecheck` |
| `pnpm test` | Тесты vitest. Нужны `TEST_DATABASE_URL`, `TEST_REDIS_URL` и `docker compose up postgres redis` | `pnpm test` |
| `pnpm --filter <пакет> test` | Тесты одного пакета | `pnpm --filter @ai-door/agent test` |

## Ревью с Claude

| Навык | Что делает | Пример |
|---|---|---|
| `/code-review` | Поиск ошибок в текущем diff или в PR, ветке, пути. Уровень усилий первым аргументом: low, medium, high, xhigh | `/code-review medium`, `/code-review high --max-findings 12`, `/code-review --fix` |
| `/security-review` | Проверка изменений ветки по правилам `REVIEW.md`: изоляция аккаунтов, секреты, ПДн, SSRF, промпт-инъекции | `/security-review` |
| `/simplify` | Упрощение и чистка изменённого кода без поиска багов | `/simplify` |
| `/run` | Запустить приложение и показать результат изменения вживую, со скриншотом | `/run api`, `/run виджет` |

Порядок перед PR: `pnpm check` → `/code-review` → `/security-review` → описание PR (что изменено, как проверено, уровень риска по `REVIEW.md`, как откатить).

## Запуск и сборка

| Команда | Что делает | Пример |
|---|---|---|
| `docker compose up postgres redis` | Поднять базу и Redis для тестов и разработки | `docker compose up -d postgres redis` |
| `docker compose up -d --build` | Собрать и запустить всё (api, worker, postgres, redis) | `docker compose up -d --build` |
| `pnpm --filter @ai-door/api dev` | API Gateway в режиме разработки с перезапуском | `pnpm --filter @ai-door/api dev` |
| `pnpm --filter @ai-door/worker dev` | Воркер BullMQ в режиме разработки | `pnpm --filter @ai-door/worker dev` |
| `pnpm build` | Сборка api, worker и `widget.zip` | `pnpm build` |
| `pnpm widget:build` | Только архив виджета для amoМаркета | `WIDGET_API_URL=https://ai.rf-dveri.ru pnpm widget:build` |
| `pnpm db:migrate` | Применить миграции PostgreSQL (только вперёд, новые файлы в `packages/db/migrations`) | `DATABASE_URL=postgres://... pnpm db:migrate` |
| `pnpm menu` | Пересобрать страницу-шпаргалку `docs/menu.html` из этого файла | `pnpm menu` |

## Evals и нагрузка

| Команда | Что делает | Пример |
|---|---|---|
| `pnpm --filter @ai-door/evals eval` | 52 эталонных диалога на реальной модели. Нужен `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY=... TEST_DATABASE_URL=postgres://... pnpm --filter @ai-door/evals eval` |
| `pnpm --filter @ai-door/evals eval:docs` | Приёмка разбора файлов клиентов (PDF, XLSX, DWG, сканы) | `TEST_DATABASE_URL=postgres://... pnpm --filter @ai-door/evals eval:docs` |
| `pnpm --filter @ai-door/evals perf <N>` | Нагрузочный прогон на N одновременных диалогов без реальной модели | `TEST_DATABASE_URL=postgres://... pnpm --filter @ai-door/evals perf 100` |

## Сайт rf-dveri.ru и SEO

| Навык | Что делает | Пример |
|---|---|---|
| `/anthropic-skills:rf-dveri-admin` | Работа в админке UMI на rf-dveri.ru: лист замера, заголовки и метатеги, тег-блоки, тексты. Читать перед любой правкой сайта | `/anthropic-skills:rf-dveri-admin проверить заголовки раздела «Входные двери»` |
| `/anthropic-skills:seo-audit` | Технический и on-page SEO-аудит: индексация, метатеги, перелинковка, микроразметка, скорость | `/anthropic-skills:seo-audit https://rf-dveri.ru/catalog/` |
| `/anthropic-skills:programmatic-seo` | Шаблонные посадочные страницы: город + услуга, категории, сравнения, каталоги | `/anthropic-skills:programmatic-seo страницы «двери в <город>»` |

## Браузер и компьютер пользователя

| Навык | Что делает | Пример |
|---|---|---|
| `/anthropic-skills:built-in-browser` | Встроенный браузер приложения Claude: вкладки, вход на сайты, чтение страниц. Читать перед первым шагом в нём | `/anthropic-skills:built-in-browser открыть админку rf-dveri.ru` |
| `/anthropic-skills:chrome-browser` | Расширение Claude in Chrome: работа в вашем реальном Chrome с вашими входами | `/anthropic-skills:chrome-browser проверить виджет в amoCRM` |
| `/anthropic-skills:computer-use` | Управление рабочим столом: скриншоты, клики, ввод в приложениях на вашем компьютере | `/anthropic-skills:computer-use открыть Finder` |

## Документы и отчёты

| Навык | Что делает | Пример |
|---|---|---|
| `/anthropic-skills:docs` | Документ в Artifacts → Docs: отчёт, регламент, инструкция. Экспорт в Word, PDF, Google Docs | `/anthropic-skills:docs отчёт по фазе 6` |
| `/anthropic-skills:docx` | Создать, прочитать или править файл Word, в том числе с правками и комментариями | `/anthropic-skills:docx договор оферты в .docx` |
| `/anthropic-skills:xlsx` | Создать или поправить таблицу Excel или CSV: формулы, форматирование, чистка данных | `/anthropic-skills:xlsx выгрузить правила цен из packages/pricing` |
| `/anthropic-skills:pdf` | Прочитать, собрать, разделить PDF, извлечь таблицы, OCR сканов, заполнить формы | `/anthropic-skills:pdf извлечь таблицу из накладной` |
| `/anthropic-skills:pptx` | Презентация PowerPoint: создать, прочитать, изменить | `/anthropic-skills:pptx презентация виджета для amoМаркета` |
| `/anthropic-skills:google-workspace` | Создать или изменить Google Doc, Sheet, Slides на вашем Диске | `/anthropic-skills:google-workspace таблица замеров в Google Sheets` |
| `/anthropic-skills:internal-comms` | Внутренние коммуникации: статус-отчёты, обновления для руководства, FAQ, разбор инцидентов | `/anthropic-skills:internal-comms статус проекта за неделю` |
| `/anthropic-skills:deep-research` | Исследование темы по многим источникам с развёрнутым отчётом | `/anthropic-skills:deep-research требования amoМаркета к виджетам 2026` |

## Данные и аналитика

| Навык | Что делает | Пример |
|---|---|---|
| `/data:analyze` | Ответить на вопрос по данным: от одной метрики до полного анализа причин | `/data:analyze почему упала конверсия диалогов в октябре` |
| `/data:explore-data` | Профиль нового набора данных: пропуски, распределения, дубли, качество | `/data:explore-data журнал диалогов за месяц` |
| `/data:write-query` | Написать SQL под нужный диалект из описания на русском | `/data:write-query сделки по месяцам с средним чеком, PostgreSQL` |
| `/data:sql-queries` | Правильный и быстрый SQL: CTE, оконные функции, оптимизация, перевод между диалектами | `/data:sql-queries ускорить запрос к таблице dialogs` |
| `/data:statistical-analysis` | Статистика: описательная, тренды, выбросы, проверка гипотез, корреляции | `/data:statistical-analysis значимо ли выросла конверсия после фазы 5` |
| `/data:validate-data` | Проверка анализа перед отправкой: методика, точность, смещения | `/data:validate-data проверить отчёт по стоимости токенов` |
| `/data:create-viz` | График публикационного качества на Python | `/data:create-viz тренд стоимости диалога по неделям` |
| `/data:data-visualization` | Выбор типа графика и принципы оформления, доступность, цвет | `/data:data-visualization какой график для сравнения сегментов` |
| `/data:build-dashboard` | Интерактивный HTML-дашборд с карточками KPI, фильтрами и таблицами | `/data:build-dashboard дашборд по диалогам и расходам` |
| `/data:data-context-extractor` | Создать или дополнить навык со знаниями о вашей БД: термины, метрики, типовые запросы | `/data:data-context-extractor создать навык по схеме aidoor` |
| `/dataviz` | Правила для любого графика и дашборда: форма, палитра, подписи, взаимодействие. Читать перед первой строкой кода графика | `/dataviz` |

## Дизайн и интерфейс

| Навык | Что делает | Пример |
|---|---|---|
| `/anthropic-skills:frontend-design` | Выразительный фронтенд: лендинги, дашборды, типографика, адаптивность, анимация | `/anthropic-skills:frontend-design страница настроек виджета` |
| `/design:design-critique` | Структурированный разбор дизайна: удобство, иерархия, консистентность | `/design:design-critique экран песочницы виджета` |
| `/design:accessibility-review` | Аудит доступности по WCAG 2.1 AA: контраст, клавиатура, размер целей, скринридер | `/design:accessibility-review панель сделки` |
| `/design:design-handoff` | Спецификация для разработчиков: сетка, токены, состояния, брейкпоинты, анимации | `/design:design-handoff форма настроек` |
| `/design:design-system` | Аудит, документация или расширение дизайн-системы | `/design:design-system проверить жёстко заданные цвета в виджете` |
| `/design:ux-copy` | Микротексты: ошибки, пустые состояния, кнопки, подтверждения | `/design:ux-copy текст ошибки при истёкшем токене amo` |
| `/design:user-research` | План исследования, гайд интервью, юзабилити-тест, анкета | `/design:user-research гайд интервью с менеджерами продаж` |
| `/design:research-synthesis` | Синтез интервью, опросов и тикетов в темы, инсайты и рекомендации | `/design:research-synthesis разобрать отзывы менеджеров` |

## Claude Code: настройка и расширение

| Навык | Что делает | Пример |
|---|---|---|
| `/menu` | Эта шпаргалка. Аргумент сужает вывод до группы | `/menu`, `/menu данные` |
| `/init` | Пересобрать `CLAUDE.md` по коду | `/init` |
| `/loop` | Повторять команду с интервалом; без интервала Claude сам выбирает темп | `/loop 10m проверь статус CI` |
| `/update-config` | Правки `settings.json`: хуки, разрешения, переменные окружения, автоматизация «каждый раз когда…» | `/update-config разрешить команды pnpm` |
| `/fewer-permission-prompts` | Собрать allowlist в `.claude/settings.json`, чтобы меньше запросов разрешений | `/fewer-permission-prompts` |
| `/keybindings-help` | Настроить горячие клавиши в `~/.claude/keybindings.json` | `/keybindings-help переназначить ctrl+s` |
| `/session-start-hook` | Хук SessionStart для облачных сессий: установка зависимостей при старте | `/session-start-hook` |
| `/anthropic-skills:skill-creator` | Создать новый навык, улучшить существующий, прогнать его evals | `/anthropic-skills:skill-creator навык для правил цен` |
| `/plugin-authoring` | Мод интерфейса Claude: тема, панель, строка статуса, слэш-команда, хук | `/plugin-authoring строка статуса с веткой и тестами` |
| `/workflow-authoring` | Справочник по сценариям Workflow с оркестрацией субагентов | `/workflow-authoring` |
| `/claude-api` | Справочник по Claude API и SDK: модели, цены, параметры, инструменты, кеширование | `/claude-api сколько стоит кеширование промпта` |
| `/anthropic-skills:context-manager` | Ведение рабочего состояния, журнала решений и требований в долгих задачах | `/anthropic-skills:context-manager` |
| `/anthropic-skills:context-optimization` | Сократить расход токенов в длинной сессии без потери решений и требований | `/anthropic-skills:context-optimization` |
| `/anthropic-skills:import-memory` | Импорт экспорта памяти из другого AI-ассистента | `/anthropic-skills:import-memory` |
| `/n8n-knowledge:n8n-knowledge` | Глубокий поиск по базе знаний n8n: решения сообщества, issues, спецификации нод | `/n8n-knowledge:n8n-knowledge как переподключить Telegram-триггер` |

Страница с кнопками «Копировать»: `docs/menu.html` (открыть в браузере).
