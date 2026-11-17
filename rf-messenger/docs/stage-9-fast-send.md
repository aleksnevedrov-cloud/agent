# Скорость и безотказность отправки сообщений (ТЗ от 17.11.2026)

Ветка `claude/new-session-vpbkn3`, папка `rf-messenger/`. Новых зависимостей нет. Миграция `007_fast_send.sql`
(`messages.sent_at`, `messages.amojo_media_msgid`, два индекса) применяется сама при старте `api`.

## Что изменено

| № ТЗ | Было | Стало | Где |
|---|---|---|---|
| 4.1 | API держал HTTP до 60 с, пока connectors отправит | Окно переписки: сообщение сохраняется «в очереди», ставится в очередь канала, ответ ≤ 1 с; «отправлено» / «ошибка: причина» приходят по SSE (`status`). «Написать»: ответ сразу — талон, результат виджет забирает по `GET /widget/v1/chats/start/:ticket` раз в 0,7 с до 30 с | `bridge.queueFromWindow`, `api/chat.ts`, `api/app.ts`, `workers.ts`, `widget/src/index.ts` (`awaitStart`) |
| 4.2 | Одна очередь `rfm-start-chat` на 2 исполнителя для всех каналов | У каждого канала своя очередь `rfm-ch-<id>` и свой Worker (2 задачи одновременно). Исполнители создаются при сверке каналов. Зависший канал занимает только своих исполнителей | `queue.ts` (`BullJobQueue`), `workers.ts` (`ChannelWorkers`), `main-connectors.ts` |
| 4.3 | Запрос 30 с, до 5 повторов (≈ 3,5 мин) | Отправка текста: один запрос ≤ 10 с, не больше одного повтора (VK, MAX-бот, MAX по номеру, Авито, Telegram-бот); вся отправка ≤ 20 с (`SEND_TIMEOUT_MS`), иначе «<канал> не ответил». Повтор не создаёт дубль: VK `random_id` выводится из ключа сообщения `rfm-m<id>`; очередь повторяет задачу с тем же ключом | `connectors/http.ts` (`SEND_CALL`, `retries` на запрос), `vk.ts`, `max.ts`, `max-greenapi.ts`, `avito.ts`, `telegram-bot.ts`, `bridge.deliverToChannel` |
| 4.4 | «Сервис мессенджеров недоступен» на любой сбой | Виджет показывает причину из ответа; без ответа — «Нет ответа от сервиса…», по кодам 502/503/504/401/403/429 — свои тексты. Ошибки отправки всегда с названием канала («Telegram-бот: Клиент заблокировал бота»). nginx: `proxy_read_timeout 300s`, `proxy_buffering off` для SSE (`docs/deploy.md`) | `describeAjaxError`, `bridge.deliverToChannel`, `docs/deploy.md` |
| 4.5 | Пауза 1–3 с + «печатает» 1,2 с во всех каналах | Решение заказчика от 17.11 (п. 6, вариант 2): для личных аккаунтов (`PACED_KINDS`: WhatsApp по QR, Telegram личный, MAX по номеру) **пауза 0,3–1 с, «печатает» отправляется, но не задерживает сообщение**; боты и сообщества (VK, Telegram-бот, MAX-бот, Авито) без паузы всегда. Настройки `OUTBOUND_PAUSE_MIN_MS=300`, `OUTBOUND_PAUSE_MAX_MS=1000`, `OUTBOUND_TYPING_MS=0`; прежнее поведение: 1000 / 3000 / 1200 в `.env` | `config.ts`, `channels.ts`, `bridge.onAmoHook`, `bridge.deliverToChannel` |
| 4.6 | Скачивание вложения (до 90 с) и история — в одной очереди с текстом | Очередь `rfm-media` (2 исполнителя): задачи `media` и `history`. Входящее с фото и текстом: текст уходит в amo сразу, файл — отдельным сообщением `rfm-m<id>-media` после скачивания; без текста — ждёт файл; после последней неудачи — «[Вложение не получено]» | `bridge.onInbound`, `fetchInboundMedia`, `deliverMediaToAmo` |
| 4.7 | 10 попыток, до ~85 минут | `to-channel`: 3 попытки с паузой 15 с, срок жизни 2 минуты (`deadline` в задаче). Дальше — «ошибка» с причиной в окне и в amoCRM (`delivery_status -1`) и кнопка «Повторить» (теперь и для сообщений из окна) | `queue.ts` (`TO_CHANNEL_JOB_OPTIONS`, `SEND_DEADLINE_MS`), `bridge.retryMessage`, `widget/src/chat.ts` |
| 4.8 | api 160 МБ, connectors 512 МБ | api 320 МБ, connectors 1024 МБ (×2; уточнить по замеру п. 3.4). Перезапуск любого процесса — уведомление в Telegram с временем прошлого запуска | `docker-compose.yml`, `alerts.restartText`, `main-connectors.ts`, `main-api.ts` |
| 4.9 | Только «канал не подключён > 5 мин» | Добавлено, без 5-минутной задержки: задача ждёт в очереди > 30 с; доля ошибок канала > 20 % за 10 минут (от 3 сообщений); перезапуск контейнера. `/health` отдаёт `channels` (id, вид, статус) и `queues` (ожидают, выполняются, отложены, упали, возраст самой старой) | `alerts.collectProblems`, `api/app.ts` |
| 4.10 | — | Журнал `исходящее отправлено` {messageId, channelId, kind, source, ms}; `messages.sent_at`; `GET /widget/v1/stats?hours=24` (администратору): по каналам всего/отправлено/ошибок/в очереди, медиана и 95-й процентиль; суточная сводка в Telegram в 09:00 МСК | `store.outboundStats`, `alerts.dailySummaryText`, `workers.dailySummaryDue` |

Задачи старого формата (общая очередь `rfm-messages` с `to-channel`, очередь `rfm-start-chat`) дорабатываются
старыми исполнителями — обновление без потери сообщений, которые уже стояли в очереди.

## Тесты

`server/test/fast-send.test.ts` (11): 4.1 — ответ без коннектора, статусы по SSE, передача в amo; 4.3/4.7 — таймаут
«<канал> не ответил», срок 2 мин, «Повторить» для сообщения из окна, постоянная ошибка с названием канала;
4.2 — настоящие очереди BullMQ: канал А повис, канал Б отправляет < 3 с, «Написать» через талон (успех и ошибка),
снимок очередей, маршрутизация задач; 4.9/4.10 — проблемы очереди и доли ошибок без задержки, тексты сводки и
перезапуска, окно 09:00 МСК, `outboundStats` (медиана 600 мс, p95 > 4 с). Обновлены: `bridge.test.ts`
(бот без паузы, WhatsApp с паузой; фото — текст сразу, файл вторым сообщением), `media-stuck.test.ts`
(задача `media`, повтор и последняя попытка), `vk/max/resilience` (один повтор при отправке, `random_id` из ключа),
`api.test.ts` (талон, `/health` с очередями, ошибки до очереди), `chat-window/inbox` (очередь + исполнитель).
Виджет: `widget.test.ts` (талон и опрос, ошибка по талону, тексты HTTP-ошибок), `chat.test.ts` («Повторить» у
недоставленного из окна). Итого `pnpm check`: сервер 199, виджет 35.

## Замеры (раздел 5)

В тестовой среде (локальные Postgres/Redis, заглушка мессенджера): ответ API на «Отправить» — в пределах 1 с (тест
4.1 проверяет < 1000 мс, фактически ≈ 50–130 мс); отправка в незанятый канал при зависшем соседнем — < 3 с по тесту,
фактически ≈ 100–300 мс после постановки. Боевые цифры «до» — по п. 3.6 диагностики (SQL ниже), «после» — через
сутки по `GET /widget/v1/stats` и суточной сводке в Telegram.

## Выкладка (чат с доступом к серверу)

```bash
cd /opt/rf-messenger && git fetch origin && git checkout claude/new-session-vpbkn3 && git pull --ff-only
```

```bash
docker compose build api connectors && docker compose up -d api connectors
```

```bash
docker compose logs api --since 2m | grep -i -E "007_fast_send|listen"
```

```bash
curl -s https://chat.rf-dveri.ru/health | head -c 1500
```

Ожидается `ok: true`, в ответе списки `channels` и `queues` (`rfm-ch-<id>` на каждый активный канал).

nginx (п. 4.4): в `location /` добавить строки из `docs/deploy.md` (`proxy_read_timeout 300s`, `proxy_buffering off`,
`proxy_http_version 1.1`), затем `sudo nginx -t && sudo systemctl reload nginx`.

Виджет: `pnpm build` → `widget/dist/widget/widget.zip` загрузить в интеграцию amoCRM новой версией. Старый виджет с
новым сервером: «Написать» получит ответ `{ticket}` и покажет «Сообщение отправлено» сразу (результат не проверит) —
поэтому виджет обновить в тот же день.

Проверка после выкладки: «Написать» из карточки в VK — окно отвечает за секунду, через 1–3 с «Сообщение отправлено»;
окно переписки — сообщение появляется с 🕓 и через секунду меняется на ✓; `docker compose logs connectors | grep "исходящее отправлено"` — строки с `ms`.

Откат: `git checkout 752760b && docker compose build api connectors && docker compose up -d api connectors`; колонки
миграции 007 старому коду не мешают; задачи в очередях `rfm-ch-*` старый код не читает — перед откатом дождаться
пустых очередей (`/health` → `queues`). Виджет — предыдущий `widget.zip`.

## Диагностика «до» (раздел 3 ТЗ, только чтение)

```bash
cd /opt/rf-messenger && git rev-parse HEAD && git log --oneline -1 && git fetch -q origin && git log --oneline HEAD..origin/claude/new-session-vpbkn3
```

```bash
docker compose logs api connectors --since 2026-11-17T00:00:00Z 2>&1 | grep -E "написать первым: ошибка|отправка из карточки: не выполнено|VK " | tail -50
```

```bash
docker compose exec -T redis redis-cli --raw EVAL "local r={} for _,q in ipairs({'bull:rfm-start-chat','bull:rfm-messages'}) do r[#r+1]=q..' wait='..redis.call('LLEN',q..':wait')..' active='..redis.call('LLEN',q..':active')..' failed='..redis.call('ZCARD',q..':failed')..' delayed='..redis.call('ZCARD',q..':delayed') end return r" 0
```

```bash
docker ps -a --format '{{.Names}} {{.Status}}' | grep rf-messenger; for c in $(docker ps -aq --filter name=rf-messenger); do docker inspect -f '{{.Name}} restarts={{.RestartCount}} oom={{.State.OOMKilled}} started={{.State.StartedAt}}' $c; done; docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.MemPerc}}'
```

```bash
sudo grep -E '"(POST|GET) /widget/v1/[^"]*" (499|502|504)' /var/log/nginx/access.log* | wc -l; sudo grep -E '"(POST|GET) /widget/v1/[^"]*" (499|502|504)' /var/log/nginx/access.log | tail -20; sudo nginx -T 2>/dev/null | grep -E "proxy_read_timeout|proxy_buffering" || echo "proxy_read_timeout не задан (по умолчанию 60 с)"
```

```bash
docker compose exec -T postgres psql -U rfm -d rfm -c "
SELECT ch.id AS channel_id, ch.kind, count(*) AS total,
       count(*) FILTER (WHERE m.status IN ('sent','delivered','read','synced')) AS sent,
       count(*) FILTER (WHERE m.status = 'failed') AS failed,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (m.updated_at - m.created_at)))::numeric, 1) AS p50_sec,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (m.updated_at - m.created_at)))::numeric, 1) AS p95_sec
FROM messages m JOIN chats c ON c.id = m.chat_id JOIN channels ch ON ch.id = c.channel_id
WHERE m.direction = 'out' AND m.created_at > now() - interval '3 days'
GROUP BY ch.id, ch.kind ORDER BY ch.id;"
```

```bash
docker compose logs connectors --since 72h 2>&1 | grep -o "max-greenapi:[^\"]*" | sed -E 's/[0-9]{5,}/N/g' | sort | uniq -c | sort -rn | head -20
```

```bash
docker compose logs connectors --since 72h 2>&1 | grep "вложение не скачано" | grep -o '"channelId":[0-9]*,.*"err":"[^"]*"' | sed -E 's/"messageId":[0-9]+,//' | sort | uniq -c | sort -rn | head -20
```

Все запросы выводят только счётчики, id и тексты ошибок сервиса; телефонов и текстов клиентов в них нет.
