# События TimeCapsule

Документ описывает события, которыми обмениваются приложение и фоновые обработчики
(Lab 7, часть 2). Все события ходят через тему SNS `timecapsule-dev-events`
(`eu-central-1`), подписчики получают только те сообщения, которые их касаются —
фильтры SNS настроены на тело сообщения (`FilterPolicyScope = MessageBody`).

## 1. Общая схема

```
веб-приложение ──capsule.sealed──▶ SNS topic ──фильтр──▶ SQS timecapsule-dev-mail ──▶ Lambda timecapsule-dev-mailer
                                                                                            │
EventBridge Scheduler (раз в минуту) ──▶ Lambda timecapsule-dev-opener ──────────────────────┤
                                                   │                                        ▼
                                                   └── async destination (OnSuccess) ──▶ SNS topic ──фильтр──▶ e-mail
                                                                                            │
                                                                                            └──▶ DLQ (после 3 неудачных приёмов)
```

Ключевая идея: веб-запрос только фиксирует капсулу и публикует событие, а вся
«медленная» работа (письмо, открытие капсул по времени) выполняется вне запроса.
Поэтому время ответа `POST /seal` не зависит от почтового сервера.

## 2. `capsule.sealed` — капсула запечатана

Публикует веб-приложение сразу после `INSERT` в `capsules`.

```json
{
  "event": "capsule.sealed",
  "capsule_id": 34,
  "user_id": 1,
  "email": "user1@timecapsule.local",
  "title": "Капсула к открытию 14:19 UTC",
  "open_at": "2026-11-23T14:19:15+00:00",
  "sealed_at": "2026-11-23T14:17:13.412Z"
}
```

* Атрибут сообщения: `event = capsule.sealed` (для получателей, которые фильтруют по атрибутам).
* Подписчик: очередь `timecapsule-dev-mail` (raw delivery, фильтр `{"event": ["capsule.sealed"]}`).
* Обработчик: `timecapsule-dev-mailer`, батч 1, максимум 2 параллельных вызова.

## 3. `capsule.opened` — капсула открыта

`timecapsule-dev-opener` запускается по расписанию и возвращает результат вызова.
Lambda отправляет его в тему как асинхронное назначение «при успехе», поэтому в тему
приходит полный конверт вызова, а само событие лежит в `responsePayload`:

```json
{
  "version": "1.0",
  "timestamp": "2026-11-23T14:19:53.786Z",
  "requestContext": {"requestId": "...", "condition": "Success", "approximateInvokeCount": 1},
  "requestPayload": {},
  "responseContext": {"statusCode": 200, "executedVersion": "$LATEST"},
  "responsePayload": {
    "event": "capsule.opened",
    "count": 1,
    "opened": [
      {"capsule_id": 34, "title": "Капсула к открытию 14:19 UTC",
       "open_at": "2026-11-23T14:19:15+00:00",
       "opened_at": "2026-11-23T14:19:53.665443+00:00"}
    ],
    "checked_at": "2026-11-23T14:19:53.675504+00:00"
  }
}
```

* Подписчик: e-mail, фильтр
  `{"responsePayload": {"event": ["capsule.opened"], "count": [{"numeric": [">", 0]}]}}`.
  Пустые вызовы (`count = 0`) отбрасываются на стороне SNS и не превращаются в письма.
* Тот же конверт подходит и для будущих подписчиков (SQS, webhook): они смотрят только
  на `responsePayload.event`.

## 4. Гарантии доставки

| Свойство | Значение |
|---|---|
| Модель доставки | at-least-once (SNS → SQS, повторные вызовы Lambda) |
| Порядок | не гарантируется (standard) |
| Повторы | SQS: `maxReceiveCount = 3`; Lambda: 2 попытки для асинхронного вызова |
| DLQ | `timecapsule-dev-mail-dlq`, хранение 14 суток |
| Идемпотентность | `unique (capsule_id, kind)` + `ON CONFLICT DO NOTHING` в `notifications` |

Проверка идемпотентности: одно и то же сообщение отправлялось 4 раза — в журнале
`письмо записано` встречается один раз, остальные — `письмо уже было (дубль)`,
в таблице `notifications` одна строка на пару `(capsule_id, kind)`.

## 5. Ошибки и разбор DLQ

1. Обработчик падает → сообщение возвращается в очередь после `VisibilityTimeout` (120 с).
2. После третьего приёма SQS перекладывает сообщение в `timecapsule-dev-mail-dlq`.
3. Причина видна в журнале `/aws/lambda/timecapsule-dev-mailer` (например,
   `OperationalError: ... password authentication failed`).
4. После исправления — redrive: `Start DLQ redrive` в консоли или
   `sqs.start_message_move_task`. Сообщения возвращаются в рабочую очередь и
   обрабатываются повторно; дублей в БД не появляется.

## 6. Стоимость и ограничения

* Пустые вызовы opener (раз в минуту) почти бесплатны: ~43 200 вызовов в месяц по 70 мс.
* Сообщения в SQS хранятся 4 дня, в DLQ — 14 дней.
* Резервированную конкурентность в учебном аккаунте выделить нельзя (квота 10),
  поэтому параллелизм mailer ограничен параметром `MaximumConcurrency = 2`
  у триггера SQS.
* Секретов в коде и репозиториях нет: Lambda получает доступ к БД из переменных
  окружения, а права — из роли выполнения; приложение публикует в SNS от имени
  роли инстанса.
