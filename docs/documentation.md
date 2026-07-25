# WI Notify

Chrome-расширение (Manifest V3) для **Azure DevOps Server / TFS** и **Azure DevOps Services**. Показывает work items, назначенные текущему пользователю, и добавляет действия в popup и в форму work item.

Версия манифеста: **0.2.2**. Минимальная версия Chrome: **116**.

Страница настроек: [`options.html`](../options.html), логика — [`options.mjs`](../options.mjs).  
Фоновая оркестрация: [`background.mjs`](../background.mjs).  
API Azure DevOps: [`ado-api.mjs`](../ado-api.mjs).  
Конфиг: [`ado-config.mjs`](../ado-config.mjs).

---

## Назначение

Расширение решает две группы задач.

### В popup

- Список WI с `System.AssignedTo = @Me` (через WIQL).
- Фильтры по категории состояния: `All`, `Active`, `Proposed`, `Resolved`.
- Badge на иконке расширения со счётчиком.
- Автообновление по alarm и ручное обновление.
- Поиск по назначенным WI (`title`, `description`, `id`).
- Смена статуса WI.
- Просмотр и добавление комментариев.
- Списание времени в TimeSheet.

### На странице work item в Azure DevOps

- Кнопка **Design Review Task**: из открытой задачи на дизайн в один клик создаёт связанную задачу типа `Review` по командному шаблону, проставляет связи и открывает результат в новой вкладке.

> Кнопка AI Rewrite Description в форме WI сейчас **выключена** (`AI_FEATURES_ENABLED = false` в `content-script.mjs`). Код и handlers в background сохранены, но в UI не монтируются. В этой документации AI-сценарий не описывается как рабочий.

---

## Первоначальная настройка

1. Установить расширение в режиме разработчика (`chrome://extensions` → «Загрузить распакованное»), указав папку с `manifest.json`.
2. Открыть **Настройки**:
   - из popup — ссылка в футере;
   - или через карточку расширения в Chrome («Параметры»).
3. Заполнить блок **Основные настройки**:
   - **Коллекция** (`#api-root`) — URL корня API:
     - on-prem: `https://<хост>/tfs/<коллекция>`;
     - облако: `https://dev.azure.com/<организация>`.
   - **Проект** (`#project`) — имя Team Project.
   - **Iteration Path** (`#iteration-path`) — фильтр основного списка; `All` (пустое значение) = без фильтра итерации.
   - **Период обновления** (`#refresh-interval-minutes`) — минуты, целое ≥ 1; по умолчанию `10`.
4. Нажать **Сохранить**. Конфиг пишется в `chrome.storage.local` под ключом `adoConfig`. Background получает `chrome.storage.onChanged`, пересоздаёт alarm и обновляет список WI.
5. (Опционально) В блоке **Задача на ревью** задать название продукта и дизайн-лида, нажать **Сохранить настройки ревью**.
6. Убедиться, что в браузере выполнен вход в Azure DevOps на том же хосте (режим `session`).

### Разрешения (`permissions`)

| Разрешение | Назначение |
|------------|------------|
| `alarms` | Периодическое обновление списка WI |
| `storage` | Конфиг и состояние списка |
| `notifications` | Уведомления о новых WI |
| `clipboardRead` | Чтение буфера при создании задачи на ревью (поиск ссылки Pixso) |

### Доступ к хостам

**`host_permissions` (всегда):**

- `https://hqrndtfs.avp.ru/*` — корпоративный ADO/TFS;
- `https://hqrndtfsts.avp.ru/*` — TimeSheet;
- `https://raw.githubusercontent.com/konstantin-kuzin/wi-notify/*` — проверка обновлений манифеста;
- `https://llm.kaspersky-labs.com/v1/` — зарезервировано под AI (UI AI выключен).

**`optional_host_permissions`:**

- `https://dev.azure.com/*`;
- `https://*/*`, `http://*/*` — для произвольных коллекций при необходимости.

**Content scripts** (`content-script.mjs` + `content-script.css`, `run_at: document_idle`) инжектятся на:

- `https://hqrndtfs.avp.ru/*`
- `https://hqrndtfsts.avp.ru/*`
- `https://dev.azure.com/*`

Для другого хоста ADO пути в `manifest.json` нужно расширить вручную.

---

## Конфигурация подключения

Хранится в `chrome.storage.local`, ключ **`adoConfig`**.  
Загрузка и нормализация — `loadAdoConfig()` в [`ado-config.mjs`](../ado-config.mjs): merge `DEFAULT_ADO_CONFIG` + storage, принудительные перезаписи, затем запись полного объекта обратно в storage.

Устаревшие поля при загрузке удаляются: `repositoryId`, `selectedGroupIds`, `selectedGroupLabels`.

### Поля модели

| Поле | Default | В UI настроек | Роль |
|------|---------|---------------|------|
| `apiRoot` | `https://hqrndtfs.avp.ru/tfs/DefaultCollection` | Да | Базовый URL коллекции/организации |
| `project` | `Monorepo` | Да | Имя Team Project |
| `iterationPath` | `""` | Да (select, «All») | Фильтр итерации основного списка; пусто = без фильтра |
| `refreshIntervalMinutes` | `10` | Да | Интервал alarm в минутах |
| `apiVersion` | `6.0-preview` | Нет | При каждом `loadAdoConfig` **принудительно** ставится `6.0-preview` |
| `authMode` | `session` | Нет | `session` — cookies браузера; `pat` — Basic с PAT |
| `pat` | `""` | Нет | Токен при `authMode === "pat"` |
| `reviewWorkItemType` | `Review` | Нет (хардкод) | Тип создаваемого WI |
| `reviewTemplateId` | `251d335a-fe7f-4ac3-afb0-7417eb9e4689` | Нет (хардкод) | GUID командного шаблона «Design review» |
| `reviewTemplateTeam` | `B2B Design System Team` | Нет (хардкод) | Команда-владелец шаблона |
| `reviewDesignTypes` | `""` | Нет (хардкод) | Типы исходных WI для показа кнопки через запятую; пусто = все типы |
| `reviewPlaceholderText` | `Название и ссылка на задачу` | Нет (хардкод) | Текст в Description шаблона, заменяемый на ссылку исходной задачи |
| `reviewParentId` | `7847173` | Нет (хардкод) | Родительская задача; Review привязывается как child |
| `reviewProductName` | `""` | Да | Префикс заголовка `[Продукт] …` |
| `reviewDesignLead` | `""` | Да (hidden) | Identity для `System.AssignedTo` |
| `reviewDesignLeadName` | `""` | Да | Отображаемое имя в комбобоксе |
| `reviewDesignLeadAvatar` | `""` | Да (hidden) | URL аватара |

### Хардкод полей ревью при загрузке

При каждом `loadAdoConfig()` следующие поля **всегда** берутся из `DEFAULT_ADO_CONFIG` и **не** перекрываются устаревшими значениями из storage:

- `reviewWorkItemType`
- `reviewTemplateId`
- `reviewTemplateTeam`
- `reviewDesignTypes`
- `reviewPlaceholderText`
- `reviewParentId`

Чтобы сменить шаблон, родителя или список типов — править [`ado-config.mjs`](../ado-config.mjs) и перезагрузить расширение.

### Валидация

- `validateAdoConfig` — непустые `apiRoot` и `project`; `refreshIntervalMinutes` — целое ≥ 1.
- `validateReviewConfig` — непустые `reviewWorkItemType` и `reviewTemplateId`; если `reviewParentId` задан — положительное целое (`parseReviewParentId`).

---

## Список Work Items, badge и обновление

Реализация: [`ado-api.mjs`](../ado-api.mjs) + [`background.mjs`](../background.mjs).

### Цепочка обновления (`refreshWorkItems`)

1. Загрузка `adoConfig`, проверка `validateAdoConfig`.
2. `fetchConnectionIdentity` — `GET /_apis/connectionData` → текущий пользователь.
3. `queryAssignedWorkItemIds` — WIQL `POST {project}/_apis/wit/wiql`:
   - `System.TeamProject` = проект из конфига;
   - `System.AssignedTo = @Me`;
   - `System.State <> 'Closed'` (для основного списка);
   - если `iterationPath` не пуст — фильтр по `System.IterationPath`;
   - `ORDER BY [System.ChangedDate] DESC`.
4. `fetchWorkItemsByIds` — batch по 200: `POST {project}/_apis/wit/workitemsbatch`.
5. `mapWorkItemToItem` — маппинг в элемент UI; дополнительно отбрасывает `stateCategory === "closed"` (если не режим поиска).
6. Сортировка `sortWorkItemsNewestFirst` по `updatedAt`.
7. Сохранение в `wiState`, обновление badge, уведомления о новых id.

Триггеры: `install`, `startup`, `alarm`, `manual`, `config-change`, `service-worker-load`.

### Состояние в storage (`wiState`)

| Поле | Смысл |
|------|--------|
| `items` | Массив карточек для popup |
| `count` | Длина `items` |
| `lastCheckedAt` | ISO-время последней попытки обновления |
| `lastSuccessAt` | ISO-время последнего успешного обновления |
| `lastTrigger` | Источник обновления |
| `lastError` | Текст ошибки или `null` |
| `previousItemIds` | Id прошлого успешного списка — для детекта новых WI |
| `currentUserDisplayName` | Отображаемое имя текущего пользователя |

### Badge

- Успех: текст = `count` (пусто при 0), цвет `#0b5cab`, обычные иконки.
- Ошибка: пустой текст, цвет `#a00000`, иконки `icon-*-error.png`.

### Уведомления

При успешном обновлении, если появились id, которых не было в `previousItemIds`, показывается `chrome.notifications` (в теле — до нескольких заголовков новых WI).

### Периодичность

Alarm Chrome `refresh-work-items` с `periodInMinutes` из `refreshIntervalMinutes` (по умолчанию 10). При смене конфига alarm пересоздаётся.

### Проверка обновлений расширения

Background читает `manifest.json` с GitHub raw URL репозитория (таймаут ~3 с) и пишет состояние в `wiUpdateState` для чипа обновления в popup.

---

## Popup

Файлы: [`popup.html`](../popup.html), [`popup.mjs`](../popup.mjs), [`popup.css`](../popup.css).

### Каркас UI

- Заголовок «My Work Items», строка последней проверки, кнопка обновления, badge счётчика.
- Фильтры категорий: `all` / `active` / `proposed` / `resolved`.
- Поле поиска + кнопка очистки.
- Прокручиваемый список карточек; empty-state при пустом результате.
- Футер: ссылка на GitHub, чип обновления, «Настройки».
- Блок статуса TimeSheet `#timesheet-status`.

### Фильтрация списка

1. Из списка исключаются WI типа `requirement` (без учёта регистра).
2. Затем применяется выбранная категория `stateCategory`.
3. Группировка отображения: `active` → `proposed` → `resolved`.

### Карточка WI

- Иконка/глиф типа, заголовок-ссылка (открытие WI в новой вкладке).
- Относительный «возраст» по `updatedAt`.
- Кликабельный бейдж статуса.
- Кнопка комментариев со счётчиком.
- Кнопка списания времени в TimeSheet.

Сообщение ручного обновления: `manual-refresh`.

---

## Поиск

1. Пользователь вводит текст и нажимает **Enter** (только Enter запускает поиск).
2. Popup → background: `search-assigned-catalog` с `query`.
3. Background: `queryAssignedWorkItemIdsForSearch` — WIQL по `@Me`:
   - **без** фильтра `IterationPath`;
   - **без** исключения Closed;
   - `Contains` по `System.Title` и `System.Description`;
   - если query — число (опционально с `#`) — `OR [System.Id] = N`;
   - `ORDER BY [System.CreatedDate] DESC`.
4. Карточки маппятся с `includeClosed: true`.
5. В popup дополнительно клиентский `computeSearchMatches` по title/description/id и снова исключение `requirement`; сортировка по `createdAt` desc.
6. Кнопка `×` очищает поиск и возвращает UI к обычному списку.

---

## Изменение статуса Work Item

1. Клик по бейджу статуса на карточке → контекстное меню.
2. Popup → `get-status-options` + `workItemType`.
3. Background: `fetchWorkItemTypeStates` — `GET …/_apis/wit/workitemtypes/{type}/states`.
4. Выбор статуса → `update-work-item-status` + `workItemId`, `nextState`, `workItemType`.
5. Background: `updateWorkItemState` — `PATCH …/_apis/wit/workitems/{id}` с `/fields/System.State`.
6. При успехе — локальный patch в `wiState` и UI без полного refresh; notice об успехе.
7. При ошибке — меню остаётся открытым с текстом ошибки.

---

## Комментарии Work Item

### UI

- Кнопка комментариев на карточке со счётчиком (`popup__comment-badge`).
- При старте / после поиска — `bootstrapCommentCounts()` запрашивает `get-comments` для видимых элементов.
- По клику открывается блок под карточкой: загрузка / пусто / ошибка / список + форма добавления.
- Счётчик обновляется по фактическому числу загруженных комментариев.

### Сообщения

| Сообщение | Направление | Результат |
|-----------|-------------|-----------|
| `get-comments` | popup → background | `{ ok, workItemId, comments }` |
| `add-comment` | popup → background | после записи — обновлённый список комментариев |

Перед обоими действиями: `loadAdoConfig` + `validateAdoConfig`.

### Azure DevOps API

- Чтение: `fetchWorkItemComments` — `GET {project}/_apis/wit/workItems/{id}/comments`; при `404` — пустой список; сортировка от новых к старым.
- Запись: `createWorkItemComment` — `PATCH …/workitems/{id}` в `/fields/System.History` (совместимость со старым Azure DevOps Server); `\n` → `<br>`; затем повторное чтение комментариев.

Практический нюанс: UI ADO может показывать Discussion/History как «комментарии», а endpoint comments API — только данные нового Comments API. При расхождении счётчика с UI ADO проверяйте, где хранится запись.

---

## Списание времени в TimeSheet

Файлы: [`popup.mjs`](../popup.mjs), [`background.mjs`](../background.mjs), [`timesheet-api.mjs`](../timesheet-api.mjs).

1. На карточке открывается меню `popup__effort-menu`: дата + варианты часов от `0.5` до `8.0` с шагом `0.5`, ссылка «Перейти в TimeSheet».
2. Popup → `add-to-timesheet` + `workItemId`, `hours`, `date`.
3. Background берёт `uniqueName` текущего пользователя из `fetchConnectionIdentity` и вызывает `addWorkItemEffortToCurrentWeek`.
4. Интеграция (корень по умолчанию `https://hqrndtfsts.avp.ru/TimeSheet`):
   - определяет неделю выбранной даты;
   - находит день записи;
   - при необходимости добавляет WI через `WorkItemService`;
   - сохраняет усилие через `POST /api/WorkItemEffortService/` с **пустой** `Activity` (чтобы не попадать в AutoTrack/Analysis);
   - перечитывает табель и проверяет рост значения (retry до 6×450 ms).
5. Ограничение одного действия: `hours > 0` и `hours ≤ 8`.
6. Статус показывается в `#timesheet-status` (автоскрытие ~6.5 с).

---

## Создание задачи на ревью (Design Review Task)

Сценарий встраивается в форму work item Azure DevOps и создаёт задачу типа **`Review`** через REST API (не через UI-форму «create/Review»).

### Файлы и роли

| Файл | Роль |
|------|------|
| [`content-script.mjs`](../content-script.mjs) / [`content-script.css`](../content-script.css) | Кнопка в форме WI, toast, чтение буфера, сообщение в background |
| [`background.mjs`](../background.mjs) | Handler `create-review-task`, валидация, открытие вкладки |
| [`ado-api.mjs`](../ado-api.mjs) | `createReviewWorkItem`, шаблон, PATCH связей |
| [`ado-config.mjs`](../ado-config.mjs) | Дефолты и хардкод параметров ревью |
| [`options.html`](../options.html) / [`options.mjs`](../options.mjs) | UI: название продукта, дизайн-лид |

### Настройки пользователя (options)

Блок **Задача на ревью** (`#review-options-form`):

1. **Название продукта** (`#review-product-name`) — если задано, заголовок Review: `[Продукт] <заголовок исходной задачи>`; если пусто — заголовок копируется как есть.
2. **Дизайн-лид** — комбобокс поиска пользователей (`search-identities`, debounce 300 ms, минимум 2 символа). Если выбран — `System.AssignedTo` новой задачи; если очищен — поле не назначается.
3. **Сохранить настройки ревью** (`#save-review-button`) — пишет `reviewProductName`, `reviewDesignLead*` в `adoConfig` и снова проставляет хардкод-поля ревью из дефолтов.

Шаблон, родитель, тип WI и плейсхолдер Description в UI **не редактируются** (см. таблицу конфига выше).

### Когда показывается кнопка

Функция `shouldShowReviewButton()` / `addReviewButton()`:

1. На странице есть форма work item.
2. Из URL извлечён номер сохранённой задачи:
   - `/_workitems/edit/{id}` или `/_workitems/view/{id}`;
   - либо query `?id=` / `?workitem=`.
3. На форме **создания** без id кнопка **не** показывается.
4. Если `reviewDesignTypes` непустой — тип исходной WI должен совпасть (без учёта регистра). Сейчас дефолт пустой → кнопка на **всех** типах.
5. Если тип не удалось прочитать из DOM, а список типов задан — поведение по умолчанию: **показывать**.

Монтирование устойчиво к SPA-перерисовкам: `MutationObserver` на `document.body` + реакция на изменение `adoConfig` в storage.

### Как выглядит кнопка

Подпись: **Design Review Task** (глиф типа Review из шрифтов Bowtie / AzDevMDL2).

Два варианта встраивания:

1. **Классический TFS / Azure DevOps Server** — пункт меню `li.menu-item` сразу после кнопки Save в menu-bar (совпадают размер и шрифт).
2. **Bolt UI** — secondary-кнопка в command bar тулбара формы (селекторы `.bolt-header-commandbar .ms-CommandBar-primaryCommands` и аналоги).

Tooltip: «Создать связанную задачу типа Review из этой задачи на дизайн».

### Основной сценарий (пользователь)

1. Открыть сохранённую задачу на дизайн в Azure DevOps.
2. (Опционально) Скопировать в буфер ссылку на макеты `*.pixso.net` — она подставится в раздел «Макеты».
3. Нажать **Design Review Task**.
4. Кнопка переходит в состояние ожидания: подпись «Создаём…», повторные клики блокируются (`dataset.state = pending`).
5. По завершении:
   - созданная Review открывается в новой вкладке;
   - toast сообщает успех или частичный сбой связей;
   - исходная задача остаётся открытой.

Таймаут ожидания ответа в content-script: **65 000 ms**. В background — **60 000 ms**.

### Pixso из буфера обмена

Сразу по клику (user gesture) вызывается `navigator.clipboard.readText()`:

- из текста ищется первый URL, hostname которого содержит `pixso.net`;
- если найден — передаётся в background как `pixsoUrl`;
- в Description шаблона строка-плейсхолдер  
  `Ссылка на макеты в Pixso (не забудьте дать доступ на редактирование команде ДС)`  
  заменяется на HTML-ссылку;
- если ссылки нет или чтение буфера недоступно/запрещено — создание продолжается без Pixso (ошибка буфера только логируется).

Нужно разрешение манифеста `clipboardRead`.

### Поток сообщений и API

```text
content-script                     background                      Azure DevOps
     |                                  |                               |
     |  create-review-task              |                               |
     |  { sourceId, pixsoUrl? }         |                               |
     |--------------------------------->|                               |
     |                                  |  validateAdoConfig            |
     |                                  |  validateReviewConfig         |
     |                                  |  GET workItems/{sourceId}     |
     |                                  |------------------------------>|
     |                                  |  GET …/wit/templates/{id}     |
     |                                  |------------------------------>|
     |                                  |  POST …/wit/workitems/$Review |
     |                                  |------------------------------>|
     |                                  |  PATCH relations (Related)    |
     |                                  |------------------------------>|
     |                                  |  PATCH relations (Parent)     |
     |                                  |------------------------------>|
     |                                  |  tabs.create(reviewUrl)       |
     |  { ok, id, url, warnings, … }    |                               |
     |<---------------------------------|                               |
     |  toast + fallback window.open    |                               |
```

Сообщение: тип **`create-review-task`**.

Обработчик в background:

1. `loadAdoConfig()` + `validateAdoConfig` + `validateReviewConfig`.
2. При ошибках валидации — `{ ok: false, error }` с предложением открыть настройки.
3. `createReviewWorkItem(config, { sourceId, pixsoUrl })`.
4. `chrome.tabs.create({ url: result.url, active: true })`.
5. Ответ: `{ ok: true, id, url, title, warnings, tabOpened }`.

Если `tabOpened === false`, content-script делает `window.open(url, "_blank", "noopener")`.

### Что делает `createReviewWorkItem`

1. **Исходная задача** — `fetchWorkItemById`; нужны `System.Title`, тип, проект. Без валидного id или title — ошибка.
2. **Шаблон** — `GET {project}/{team}/_apis/wit/templates/{reviewTemplateId}`:
   - team = `B2B Design System Team`;
   - templateId = `251d335a-fe7f-4ac3-afb0-7417eb9e4689`.
   Поля шаблона копируются в create-patch (кроме `System.AreaId`, `System.IterationId` и ключей с суффиксом `-Add`).
3. **Fallback**, если шаблон недоступен:
   - `KL.SizeSymbol` = `M`;
   - `KL.Design` = `New`.
4. **Title** — заголовок исходной; при непустом `reviewProductName` — `[Продукт] …`.
5. **Assigned To** — если задан `reviewDesignLead`, значение нормализуется (`normalizeAssignedToIdentity`) и пишется в `System.AssignedTo`.
6. **Description** — `applyReviewDescription`:
   - плейсхолдер `Название и ссылка на задачу` заменяется на  
     `<a href="{url}">{type} {id}</a>: {title}`;
   - если плейсхолдера нет — блок «Продуктовая задача» добавляется в начало;
   - при наличии pixsoUrl — замена плейсхолдера раздела «Макеты» (см. выше).
7. **Создание** — `POST {project}/_apis/wit/workitems/$Review` с `Content-Type: application/json-patch+json`.
8. **Связь Related** — `PATCH` на созданный WI:  
   `System.LinkTypes.Related` → API URL исходной задачи.
9. **Связь parent/child** — если `reviewParentId` валиден (`7847173` по умолчанию):  
   `System.LinkTypes.Hierarchy-Reverse` → API URL родителя (созданная Review становится child).
10. Ошибки связей **не откатывают** создание: возвращаются в массиве `warnings`.

### Обратная связь (toast)

Класс `.wi-review-toast`, kinds: `success` / `info` / `warning` / `error`.

| Исход | Поведение |
|-------|-----------|
| Полный успех | Toast об создании и связях; автоскрытие через 6 с |
| Создано, но связи с ошибками | Toast `warning` с текстом `warnings`; закрытие только вручную (×) |
| Ошибка создания / таймаут / runtime | Toast `error`; закрытие вручную |
| Задача без id | Toast: сохранить задачу и повторить |

### Ограничения сценария (as is)

- Работает только для **уже сохранённой** WI с номером.
- Создание идёт через API; предзаполненная UI-форма create не открывается.
- При частичном сбое связей созданная Review **не удаляется** — нужно донастроить вручную.
- `reviewParentId`, template id/team, типы исходных WI — только в коде (`ado-config.mjs`).
- Плейсхолдер Pixso в Description захардкожен в `ado-api.mjs`, не в конфиге.
- Content-script читает `adoConfig` из storage напрямую (для фильтра типов); хардкод типов всё равно обеспечивается `loadAdoConfig` в service worker.
- В ответе `title` сейчас равен заголовку **исходной** задачи, а не итоговому Title Review (с префиксом продукта).

---

## Структура файлов

| Файл | Роль |
|------|------|
| `manifest.json` | MV3: права, host permissions, content scripts, entrypoints |
| `background.mjs` | Service worker: alarm, badge, notifications, все message handlers, check updates |
| `ado-api.mjs` | WIQL/REST ADO, статусы, комментарии, identities, `createReviewWorkItem` |
| `ado-config.mjs` | `DEFAULT_ADO_CONFIG`, load/validate, хардкод полей ревью |
| `timesheet-api.mjs` | Запись и верификация усилий в TimeSheet |
| `popup.html` / `popup.css` / `popup.mjs` | UI списка, фильтры, поиск, статус, комментарии, TimeSheet |
| `options.html` / `options.css` / `options.mjs` | Основные настройки + задача на ревью (+ форма AI, не влияет на UI WI) |
| `content-script.mjs` / `content-script.css` | Design Review Task на странице WI |
| `ai-api.mjs` / `ai-config.mjs` | AI rewrite (UI выключен) |
| `icons/*` | Иконки расширения и шрифты глифов; `icon-*-error.png` для badge ошибки |

---

## Ограничения (as is)

- Один `apiRoot` + один `project` в конфиге; мультипроект без смены настроек не поддерживается.
- `apiVersion`, `authMode`, `pat` и большинство review*-полей не редактируются в UI.
- Основной список скрывает Closed (WIQL + category); поиск включает Closed.
- Типы `requirement` скрыты в popup (и в клиентском фильтре поиска).
- Комментарии пишутся в `System.History`, не через Comments API create.
- TimeSheet пишет только с пустой `Activity`.
- Content script ограничен hosts из манифеста.
- Устойчивость встраивания кнопки зависит от вёрстки ADO; при ненайденном тулбаре кнопка может не появиться (без поломки страницы).

---

## Проверка синтаксиса модулей

```bash
node --check background.mjs
node --check ado-api.mjs
node --check ado-config.mjs
node --check options.mjs
node --check popup.mjs
node --check content-script.mjs
node --check timesheet-api.mjs
```

Установка: режим разработчика в `chrome://extensions`, «Загрузить распакованное».
