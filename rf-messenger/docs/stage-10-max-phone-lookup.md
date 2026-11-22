# RFD-MESSENGER — дубли контактов из MAX, когда номер клиента неизвестен (ТЗ 22.11.2026)

Ветка `claude/new-session-vpbkn3`, папка `rf-messenger/`. Файлы: `server/src/connectors/max-greenapi.ts` (`getContactInfo`,
`getChats`, `lookupPhone`), `server/src/connectors/types.ts` (`Connector.lookupPhone`), `server/src/bridge.ts`
(`resolveUnknownPhone`, `linkNewChatByMaxId`, `attachChatToContact`), `server/src/amo/rest.ts` (`contactsByField`),
`server/src/store.ts` (`mergeChatContact`), `server/src/config.ts` и `.env.example` (`MAX_ID_FIELD`),
тесты `server/test/max-phone-lookup.test.ts`. Миграций нет, новых зависимостей нет.

## Ответ на п. 2.3 (диагностика до включения поиска по полю)

Из этой среды ни сервер, ни amoCRM, ни GREEN-API недоступны, поэтому сверка делается чатом с доступом к серверу
(запросы ниже). Код п. 2.4 написан, но **выключен**: включается переменной `MAX_ID_FIELD=MaxId_WZ` в `.env` только после
того, как сверка покажет совпадение `chatId` GREEN-API с полем Wazzup. Если совпадения нет, переменную не задавать —
поведение остаётся как в п. 2.5.

Запросы для сверки (вывод без телефонов и текстов):

```bash
cd /opt/rf-messenger/src/rf-messenger
# Новые чаты MAX по номеру за 7 дней без номера: id чата GREEN-API (external_chat_id) и привязка.
docker compose exec -T postgres psql -U rfm rfm -c "SELECT c.id, c.external_chat_id, c.title, (c.contact->>'phone') IS NOT NULL AS has_phone, c.amojo_chat_id IS NOT NULL AS linked, c.created_at::date FROM chats c JOIN channels ch ON ch.id = c.channel_id WHERE ch.kind = 'max_phone' AND NOT c.is_group AND c.created_at > now() - interval '7 days' ORDER BY c.created_at DESC;"
```

Затем в amoCRM у 3–5 клиентов, у которых есть и старый чат Wazzup в MAX, и новый чат РФ-Мессенджера, открыть карточку
контакта и сравнить поле «MaxId_WZ» (и «MaxUsername_WZ») с `external_chat_id` из выдачи. Ожидание по примеру из ТЗ:
чат 1028 — `external_chat_id` из 8 цифр. Совпадает у всех проверенных → задать `MAX_ID_FIELD=MaxId_WZ`.

## Что сделано (п. 2)

| № | Реализация |
|---|---|
| 2.1 | `Bridge.deliverToAmoNow` перед привязкой вызывает `resolveUnknownPhone`: личный чат канала `max_phone` без `amojoChatId` и без `contact.phone` → `connector.lookupPhone(chatId)` = GREEN-API `getContactInfo` (`phoneNumber`), при ошибке или пустом ответе — `getChats` (строка с `id = chatId`, поле `phoneNumber`). Номер есть (10–15 цифр, не 0) → `chats.contact.phone` (`mergeChatContact`, прежние поля сохраняются) → дальше обычная привязка по номеру из ТЗ от 12.11 (`linkNewChatToContact`: поиск, выбор, `createChat` → `linkChat` → сообщение) |
| 2.2 | Каждый запрос к GREEN-API — 5 с без повторов (`retries: 0`), общий предел `contactLookupTimeoutMs` 5 с. Ошибка или таймаут → сообщение уходит как раньше, в журнал предупреждение. Повтор по чату не чаще раза в 10 минут (`phoneLookupRetryMs`, в памяти процесса коннекторов). После того как первое сообщение ушло в amo без привязки, amo создаёт чат, у нас появляется `amojoChatId`, и чат считается привязанным — номер больше не запрашивается (п. 2.6) |
| 2.3 | Сверка — чатом с доступом к серверу, запросы выше |
| 2.4 | `linkNewChatByMaxId`: только канал `max_phone`, номера нет, задан `MAX_ID_FIELD`. `AmoRest.contactsByField`: `GET /api/v4/contacts?query=<chatId>&with=leads&limit=50`, затем точное сравнение значения поля с именем `MAX_ID_FIELD` (`field_name` или `field_code`) с `chatId`; сделки одним запросом; выбор при нескольких — `chooseContact` (п. 3.4 ТЗ от 12.11). Найден → `createChat` → `linkChat` → сообщение |
| 2.5 | Ничего не найдено → как сейчас: сообщение без `createChat`, amo заводит неразобранное с новым контактом |
| 2.6 | Группы (`isGroup`), чаты с `amojoChatId` (в т. ч. после «Написать» — `startChat` привязывает к контакту сделки до первого сообщения), остальные виды каналов — ни запроса номера, ни поиска по полю |
| 2.7 | Журнал connectors: `номер собеседника MAX получен у GREEN-API` (`result: номер получен`, `phone: …XXXX`), `мессенджер номер не отдал` (`result: номера нет`), `чат привязан к контакту amoCRM` (`reason: найден по MaxId_WZ: …`, `field`), `контакт по полю с id собеседника MAX не найден` (`result: не найден`), предупреждения `номер собеседника MAX не получен` / `поиск контакта по полю не выполнен`. Везде `chatId` и `channel: max_phone`; номер — только последние 4 цифры, текстов сообщений нет |

Чего не делается (п. 3): уже созданные дубли не объединяются и не удаляются; по имени контакты не сопоставляются;
AI-агент, Wazzup, старые виджеты не затронуты; клиентам ничего не пишется.

## Проверка (п. 4.1, 4.2)

| Команда | Результат |
|---|---|
| `pnpm lint`, `pnpm typecheck` | без замечаний |
| `pnpm test` | server 210 (10 новых), widget 35 — зелёные |

Новые тесты `max-phone-lookup.test.ts`: номер получен через `getContactInfo` → сохранён, найден по номеру, `createChat` →
`linkChat` → сообщение, журнал без полного номера, второй раз не запрашивается; `phoneNumber = 0` → доставлено без привязки,
«номера нет», после ответа amo запросов нет; повтор не чаще раза в 10 минут (пока чат не ушёл в amo); таймаут и ошибка
GREEN-API → доставлено с предупреждением; группа и другой канал → запроса нет; «Написать» имеет приоритет; поле не задано →
поиска по полю нет, задано → точное совпадение и привязка с причиной; по полю не найден → как сейчас; `lookupPhone`
(getContactInfo → getChats → null → ошибка без токена в тексте); `contactsByField` (адреса запросов, точная фильтрация, сделки).

## Выкладка (п. 4.3, чат с доступом к серверу)

```bash
cd /opt/rf-messenger/src/rf-messenger && git fetch origin && git checkout claude/new-session-vpbkn3 && git pull --ff-only
docker compose build connectors && docker compose up -d connectors     # api и виджет не менялись
docker compose logs connectors --since 2m | grep -ci error               # 0
```

Миграций и новых обязательных переменных нет. `MAX_ID_FIELD` в `.env` — только после сверки п. 2.3; после правки `.env`
перезапустить `connectors` (`docker compose up -d connectors`).

Проверка: тестовый номер, у которого в amoCRM есть контакт с открытой сделкой и в MAX виден номер, пишет первым
→ в журнале `номер собеседника MAX получен у GREEN-API` и `чат привязан к контакту amoCRM по номеру`, сообщение в чате
существующей сделки, нового контакта нет. Номер с закрытой приватностью → `мессенджер номер не отдал`, неразобранное как
раньше. Журнал: `docker compose logs connectors --since 1h | grep -E "номер собеседника MAX|чат привязан|по полю"`.

Откат: `git checkout 0689e2b && docker compose build connectors && docker compose up -d connectors`.

## Замер через 3 дня (п. 4.4)

```bash
docker compose exec -T postgres psql -U rfm rfm -c "SELECT count(*) AS max_chats, count(*) FILTER (WHERE c.contact->>'phone' IS NULL) AS without_phone, count(*) FILTER (WHERE c.contact->>'phone' IS NULL AND c.amojo_chat_id IS NOT NULL) AS linked_without_phone FROM chats c JOIN channels ch ON ch.id = c.channel_id WHERE ch.kind = 'max_phone' AND NOT c.is_group AND c.created_at > now() - interval '3 days';"
docker compose logs connectors --since 72h | grep -c "найден по MaxId_WZ"
```

`linked_without_phone` считает и чаты, которые amo привязал сам к новому контакту, поэтому число привязок по полю — из
второй команды (строки журнала).
