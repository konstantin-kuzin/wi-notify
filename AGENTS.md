# AGENTS.md — WI Notify

Chrome-расширение для Azure DevOps. Показывает Work Items, назначенные текущему пользователю, добавляет кнопки AI Rewrite и создания задач на ревью прямо на страницах WI, и интегрируется с TimeSheet.

## Архитектура

```
popup.mjs   — действия пользователя (список, статус, комментарии, таймшит)
    ↓ chrome.runtime.sendMessage
background.mjs — сервис-воркер: ЦУМ (хранение состояния, badge, алармы) и Хаб сообщений
    ↓   — к ADO через ado-api.mjs — к TimeSheet через timesheet-api.mjs
    ↓   — к AI через ai-api.mjs ← ai-config.mjs
content-script.mjs — DOM на страницах ADO (кнопки AI Rewrite, меню ревью)
options.mjs — страница настроек
```

## Модули

### background.mjs — сервис-воркер и ЦУМ
Главный координатор. Хранит состояние списка WI и состояние обновления в `chrome.storage.local` (`wiState`, `wiUpdateState`). Настраивает аларм `refresh-work-items` с интервалом из конфига, обновляет badge и счётчик. Слушает `chrome.runtime.onMessage` — это **Единственная точка входа** для запросов от popup, options и content-script. Каждый message type валидирует конфиг через `validateAdoConfig` (и `validateReviewConfig` для сценария ревью), затем вызывает функции из `ado-api.mjs`, `timesheet-api.mjs`, `ai-api.mjs`. Также проверяет обновления manifest.json с GitHub и показывает уведомления о новых WI.

**Типы сообщений (message.type):**
| type | отправитель | действие |
|---|---|---|
| `manual-refresh` | popup | Получить актуальный список WI, вернуть state |
| `search-assigned-catalog` | popup | Поиск по всем назначенным WI (включая закрытые) |
| `get-status-options` | popup | Список статусов для выбранного типа WI |
| `update-work-item-status` | popup | Перевести WI в новый статус + локальное обновление state |
| `add-to-timesheet` | popup | Списать время в TimeSheet |
| `get-comments` | popup | Получить комментарии WI |
| `add-comment` | popup | Добавить комментарий к WI |
| `list-work-item-queries` | options | Список сохранённых Query проекта |
| `get-wi-types` / `get-wi-tags` / `get-wi-relation-types` | options | Метаданные проекта |
| `get-wi-type-fields` | options | Поля выбранного типа WI (для «Дополнительных полей» кастомной кнопки) |
| `search-work-items` | options | Поиск WI по WIQL |
| `create-custom-wi` | content-script | Создать WI по кастомной кнопке |
| `create-review-task` | content-script | Создать задачу на ревью из шаблона |
| `rewriteDescription` (action) | content-script | AI Rewrite текста через chatCompletion |
| `ai-ping` (action) | content-script | Проверка, что background доступен |

### content-script.mjs — DOM-инъекция на страницах ADO
Инъектируется в `https://hqrndtfs.avp.ru/*`, `https://hqrndtfsts.avp.ru/*`, `https://dev.azure.com/*`. Находит редакторы Description и Discussion (textarea, contenteditable, iframe) и добавляет кнопку **AI Rewrite** рядом с ними. На странице work item добавляет пункты в меню «...» формы: **Создать задачу на дизайн-ревью** (для типов Task/Mockup/Requirement) и кастомные кнопки из настроек. Отправляет сообщения в background через `chrome.runtime.sendMessage` с `await` + fallback на `chrome.runtime.lastError`.

### popup.mjs — browser action popup
UI со списком WI. Позволяет фильтровать (All/Active/Proposed/Resolved), искать по каталогу, менять статус через выпадающее меню, просматривать и добавлять комментарии, снимать время в TimeSheet. Запрашивает state у background по `manual-refresh` и сохраняет локальные изменения (WiUpdateState) в `chrome.storage.local`.

### options.mjs — страница настроек
Табы: **Основные**, **Ревью**, **AI Rewrite**, **Кастомные кнопки**. Управляет сохранением/загрузкой конфигов (`adoConfig`, `aiConfig`) через `chrome.storage.local`, валидирует их через `validateAdoConfig`/`validateReviewConfig`/`validateAiConfig`, запрашивает метаданные проекта (типы WI, теги, Query) у background.

### ado-api.mjs — клиент Azure DevOps REST API
Функции для всех ADO операций: `adoFetch` (с retry на 429 и экспоненциальной задержкой), `fetchWorkItemsByIds`, `queryAssignedWorkItemIds`, `createReviewWorkItem`, `createCustomWorkItem`, `createWorkItemComment`, `fetchWorkItemComments`, `updateWorkItemState`, `searchWorkItems`, `fetchConnectionIdentity`, `fetchProjectWorkItemTypes`, `fetchWorkItemTypeFields`, `fetchProjectTags`, `fetchWorkItemRelationTypes`, `resolveWorkItemTypeIcons`, `resolveStateCategoriesByType`, `sortWorkItemsNewestFirst`, `mapWorkItemToItem`. Использует кэширование для metadata (typeStates, icons, projectGuid).

### ado-config.mjs — конфигурация ADO и валидация
`DEFAULT_ADO_CONFIG` с полями: `apiRoot`, `project`, `workItemQueryId`, `refreshIntervalMinutes`, `apiVersion`, `authMode` (session/pat), `pat`, настройки ревью (`reviewEnabled`, `reviewProject`, `reviewTemplateId` и др.), `customReviewButtons`. `loadAdoConfig()` объединяет defaults с storage, применяет фиксированные значения для полей без UI. Валидаторы: `validateAdoConfig`, `validateReviewConfig`. Парсеры: `parseWorkItemId`, `parseReviewParentId`, `parseReviewDesignTypes`. Утилиты: `normalizeApiRoot`, `resolveApiVersion`, `resolveReviewProject`, `resolveRefreshIntervalMinutes`.

### ai-api.mjs — клиент OpenAI-compatible API
`chatCompletion(userMessage)` — загружает конфиг через `loadAiConfig`, проверяет хост-разрешения через `chrome.permissions`, отправляет запрос к `{baseUrl}/chat/completions` с системным промптом и suffix-om. `fetchAiModels(baseUrl, apiKey)` — получает список моделей. `ensureAiHostPermission` — запрашивает или проверяет permission для хоста AI-провайдера. Timeout: 90 сек.

### ai-config.mjs — конфигурация AI
`DEFAULT_AI_CONFIG` с полями: `enabled`, `useFixedProvider`, `baseUrl`, `apiModel`, `apiKey`, `servicePrompt`. `FIXED_AI_BASE_URL` = `https://llm.kaspersky-labs.com/v1/`, `FIXED_AI_MODEL` = `best-for-chat`. `loadRawAiConfig()` — как есть из storage (для формы). `loadAiConfig()` — эффективные настройки с учётом `applyFixedAiProvider`. `applyFixedAiProvider(config)` — подменяет base URL и модель фиксированными значениями когда `useFixedProvider: true`. `validateAiConfig(config)` — валидация.

### custom-wi-fields.mjs — чистые хелперы для кастомных WI
Тестируются через node:test. `resolveCustomTitle`, `tagsToFieldValue`, `descriptionToHtml`, `buildCustomWorkItemFields`, `applyCustomFields` (дополнительные поля кнопки), `coerceCustomFieldValue` (значение → тип для PATCH: number/boolean/ISO-дата), `isComputedWorkItemField` (фильтр служебных полей). Собирает поля ADO для создаваемого Work Item по конфигу кастомной кнопки (title, areaPath, tags, description, assignedTo, customFields и т.д.).

### timesheet-api.mjs — интеграция TimeSheet
`addWorkItemEffortToCurrentWeek({login, workItemId, hours, date})` — добавляет/увеличивает усилие для work item в текущей неделе. Разрешает login через API, загружает timesheet model, создает задачу если нужно, сохраняет effort и верифицирует. Использует `https://hqrndtfsts.avp.ru/TimeSheet`.

## Уровни слоёв

1. **UI слой**: popup.mjs, options.mjs, content-script.mjs (DOM)
2. **Сервисный слой**: background.mjs (ЦУМ, badge, алармы, хаб сообщений)
3. **API слой**: ado-api.mjs, timesheet-api.mjs, ai-api.mjs
4. **Конфиг слой**: ado-config.mjs, ai-config.mjs
5. **Чистые хелперы**: custom-wi-fields.mjs

## Рабочие циклы

### Автообновление списка WI
`chrome.alarms.onAlarm` → `refreshWorkItems()` → `fetchAssignedWorkItemsForSearchQuery` / `queryAssignedWorkItemIds` → `fetchWorkItemsByIds` → `mapWorkItemToItem` → `saveState` → `updateBadge` → `showNotification` (если новые).

### AI Rewrite текста
content-script находит редактор → пользователь кликает "AI Rewrite" → `sendMessage({action: 'rewriteDescription', ...})` → background: `buildRewritePrompt` + `chatCompletion` → ответ → content-script вставляет rewritten text в редактор.

### Создание задачи на ревью
content-script: пункт меню "Создать задачу на ревью" → `sendMessage({type: 'create-review-task'})` → background: `validateAdoConfig` + `validateReviewConfig` + `createReviewWorkItem` → `chrome.tabs.create` → ответ с id/url.

### Сохранение времени
popup: пользователь вводит часы → `sendMessage({type: 'add-to-timesheet'})` → background: `fetchConnectionIdentity` + `addWorkItemEffortToCurrentWeek` → ответ.

## Тестирование
В папке `test/` есть node:test-тесты для `custom-wi-fields.mjs` и других чистых модулей. Запуск: `node --test`.

## Ключевые соглашения
- `loadConfig()` возвращает эффективные настройки, `loadRawConfig()` — как есть из storage (для формы).
- Content-script использует `role="application"` и `aria-hidden` для изоляции клавиатурных событий.
- ADO API использует `credentials: "include"` для `authMode: "session"`, `omit` для PAT.
- Имена message используют `type` (для background) и `action` (для специфичных действий вроде AI).
