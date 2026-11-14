---
name: menu
description: Шпаргалка по навыкам и командам этого репозитория. Вызывать, когда пользователь набирает /menu, спрашивает «какие есть команды», «что умеешь», «как запустить проверку», или не помнит имя и аргументы навыка.
---

# /menu — шпаргалка по навыкам и командам

Покажи пользователю таблицы ниже как есть, на русском, без сокращений и без пересказа.
Если в `/menu` передан аргумент (например, `/menu ревью` или `/menu evals`), покажи только подходящие группы.
Ничего не запускай сам: это справка. После таблиц одной строкой предложи выполнить выбранный пункт.

## Проверка кода (перед каждым коммитом и PR)

| Команда | Что делает | Пример |
|---|---|---|
| `pnpm check` | Полная проверка: lint + поиск секретов + typecheck + тесты. Красное — не коммитить | `pnpm check` |
| `pnpm lint` | Только ESLint | `pnpm lint` |
| `pnpm secrets` | Поиск ключей и паролей в отслеживаемых файлах | `pnpm secrets` |
| `pnpm typecheck` | Только типы TypeScript во всех пакетах | `pnpm typecheck` |
| `pnpm test` | Тесты vitest. Нужны `TEST_DATABASE_URL`, `TEST_REDIS_URL` и `docker compose up postgres redis` | `pnpm test` |
| `pnpm --filter <пакет> test` | Тесты одного пакета | `pnpm --filter @ai-door/agent test` |

## Ревью с Claude (навыки)

| Навык | Что делает | Пример |
|---|---|---|
| `/code-review` | Поиск ошибок в текущем diff или в PR, ветке, пути. Уровень усилий первым аргументом | `/code-review medium`, `/code-review high --max-findings 12`, `/code-review --fix` |
| `/security-review` | Проверка изменений ветки по правилам `REVIEW.md`: изоляция аккаунтов, секреты, ПДн, SSRF, промпт-инъекции | `/security-review` |
| `/simplify` | Упрощение и чистка изменённого кода без поиска багов | `/simplify` |
| `/run` | Запустить приложение и показать результат изменения вживую | `/run api`, `/run виджет` |

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

## Evals и нагрузка

| Команда | Что делает | Пример |
|---|---|---|
| `pnpm --filter @ai-door/evals eval` | 52 эталонных диалога на реальной модели. Нужен `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY=... TEST_DATABASE_URL=postgres://... pnpm --filter @ai-door/evals eval` |
| `pnpm --filter @ai-door/evals eval:docs` | Приёмка разбора файлов клиентов (PDF, XLSX, DWG, сканы) | `TEST_DATABASE_URL=postgres://... pnpm --filter @ai-door/evals eval:docs` |
| `pnpm --filter @ai-door/evals perf <N>` | Нагрузочный прогон на N одновременных диалогов без реальной модели | `TEST_DATABASE_URL=postgres://... pnpm --filter @ai-door/evals perf 100` |

## Сайт rf-dveri.ru и SEO

| Навык | Что делает | Пример |
|---|---|---|
| `/anthropic-skills:rf-dveri-admin` | Работа в админке UMI на rf-dveri.ru: лист замера, заголовки и метатеги, тег-блоки, тексты | `/anthropic-skills:rf-dveri-admin проверить заголовки раздела «Входные двери»` |
| `/anthropic-skills:seo-audit` | Технический и on-page SEO-аудит сайта или страницы | `/anthropic-skills:seo-audit https://rf-dveri.ru/catalog/` |
| `/anthropic-skills:programmatic-seo` | Шаблонные посадочные страницы: город + услуга, категории, сравнения | `/anthropic-skills:programmatic-seo страницы «двери в <город>»` |

## Документы и отчёты

| Навык | Что делает | Пример |
|---|---|---|
| `/anthropic-skills:docs` | Документ в Artifacts → Docs: отчёт, регламент, инструкция | `/anthropic-skills:docs отчёт по фазе 6` |
| `/anthropic-skills:xlsx` | Создать или поправить таблицу Excel, например правила цен | `/anthropic-skills:xlsx выгрузить правила цен из packages/pricing` |
| `/anthropic-skills:pdf` | Прочитать, собрать, разделить PDF | `/anthropic-skills:pdf извлечь таблицу из накладной` |
| `/anthropic-skills:deep-research` | Исследование темы по многим источникам с отчётом | `/anthropic-skills:deep-research требования amoМаркета к виджетам 2026` |

## Служебные

| Навык | Что делает | Пример |
|---|---|---|
| `/loop` | Повторять команду с интервалом | `/loop 10m проверь статус CI` |
| `/init` | Пересобрать `CLAUDE.md` по коду | `/init` |
| `/fewer-permission-prompts` | Добавить allowlist в `.claude/settings.json`, чтобы меньше спрашивало разрешений | `/fewer-permission-prompts` |
| `/update-config` | Правки `settings.json`: хуки, разрешения, переменные окружения | `/update-config разрешить команды pnpm` |

Страница с кнопками «Копировать»: `docs/menu.html` (открыть в браузере).
