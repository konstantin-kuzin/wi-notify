# WI Notify

Chrome-расширение для Azure DevOps, которое показывает Work Items, назначенные текущему пользователю.

## Что умеет

- Показывает назначенные вам WI в popup.
- Фильтрует список по категориям состояния: `All`, `Active`, `Proposed`, `Resolved`.
- Показывает бейдж со счётчиком на иконке расширения.
- Обновляет данные автоматически каждые 10 минут и вручную.
- Отображает время последней проверки.
- Выполняет поиск по бэкенду Azure DevOps по полям:
  - `title`
  - `description`
  - `id`
- Сортирует результаты поиска по дате создания (новые сверху).

## Установка (локально)

1. Клонируйте репозиторий:
   ```bash
   git clone https://github.com/konstantin-kuzin/wi-notify.git
   cd pr-notify
   ```
2. Откройте в Chrome страницу `chrome://extensions`.
3. Включите **Режим разработчика**.
4. Нажмите **Загрузить распакованное расширение**.
5. Выберите папку проекта (где лежит `manifest.json`).

После изменения кода нажимайте кнопку обновления на карточке расширения в `chrome://extensions`.

## Настройка

Откройте **Настройки** из popup или через карточку расширения в Chrome.

Поля:

- **Коллекция** (`apiRoot`)
  - On-prem/TFS: `https://<server>/tfs/<collection>`
  - Cloud: `https://dev.azure.com/<org>`
- **Проект** (`project`) — имя Team Project.
- **Iteration Path** (`iterationPath`) — фильтр для основного списка WI в popup.
  - `All` = без фильтра итерации.

### Авторизация

По умолчанию используется `session` (cookie текущей сессии браузера в ADO).  
Параметры `apiVersion`, `authMode`, `pat` задаются в конфиге (`ado-config.mjs`/storage) при необходимости.

## Как работает поиск

- Пользователь вводит текст в поле поиска и нажимает `Enter`.
- Popup отправляет запрос в background.
- Background выполняет WIQL-поиск по назначенным `@Me`:
  - без фильтра по `IterationPath`;
  - с учётом всех статусов;
  - `Contains` по `System.Title` и `System.Description`;
  - точное совпадение по `System.Id`, если введён числовой ID.
- Затем загружаются карточки WI и отображаются в popup.
- Кнопка `×` очищает поле поиска, результаты и возвращает UI к базовому состоянию.

## Структура проекта

- `manifest.json` — манифест MV3 и разрешения.
- `background.mjs` — обновления, badge, уведомления, обработка сообщений popup.
- `ado-api.mjs` — запросы к Azure DevOps API и маппинг WI.
- `ado-config.mjs` — модель и загрузка конфигурации.
- `options.html`, `options.css`, `options.mjs` — страница настроек.
- `popup.html`, `popup.css`, `popup.mjs` — UI popup и взаимодействие пользователя.

## Разрешения

Используются разрешения из `manifest.json`:

- `alarms`
- `storage`
- `notifications`

И доступ к ADO-хостам через `host_permissions`/`optional_host_permissions`.

