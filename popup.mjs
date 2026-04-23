const STORAGE_KEY = "wiState";
const REFRESH_MESSAGE_TYPE = "manual-refresh";
const SEARCH_CATALOG_MESSAGE_TYPE = "search-assigned-catalog";
const GET_STATE_OPTIONS_MESSAGE_TYPE = "get-status-options";
const UPDATE_WORK_ITEM_STATE_MESSAGE_TYPE = "update-work-item-status";
const ADD_TO_TIMESHEET_MESSAGE_TYPE = "add-to-timesheet";
const DEFAULT_FILTER = "all";
const DEFAULT_STATE = {
  items: [],
  count: 0,
  lastCheckedAt: null,
  lastError: null,
  currentUserDisplayName: "",
};

const countBadge = document.querySelector("#count-badge");
const lastUpdated = document.querySelector("#last-updated");
const messageBox = document.querySelector("#message-box");
const timesheetStatusBox = document.querySelector("#timesheet-status");
const emptyState = document.querySelector("#empty-state");
const itemsList = document.querySelector("#items-list");
const refreshButton = document.querySelector("#refresh-button");
const optionsLink = document.querySelector("#options-link");
const filterButtons = [...document.querySelectorAll("[data-filter]")];
const searchInput = document.querySelector("#search-input");
const searchClearButton = document.querySelector("#search-clear");
const STATE_GROUP_ORDER = ["active", "proposed", "resolved"];
const STATE_GROUP_LABELS = {
  active: "Active",
  proposed: "Proposed",
  resolved: "Resolved",
};
const WORK_ITEM_TYPE_ICONS = {
  task: {
    className: "popup__type-glyph--task",
    glyph: "\ueabf",
    useFont: true,
  },
  review: {
    className: "popup__type-glyph--review",
    glyph: "\ueac4",
    useFont: true,
  },
  bug: {
    className: "popup__type-glyph--bug",
    glyph: "\ueabc",
    useFont: true,
  }
};

let isRefreshing = false;
let currentFilter = DEFAULT_FILTER;
let currentState = { ...DEFAULT_STATE };
/** Режим списка после поиска по Enter (по всем статусам). */
let isSearchMode = false;
/** Последний выполненный запрос (для повторного применения при обновлении данных). */
let lastSearchQuery = "";
let searchResultItems = [];
/** Элементы каталога с Azure DevOps (все назначенные @Me, без iteration из настроек). */
let searchBackendItems = [];
let isSearchLoading = false;
let searchFetchError = "";
let statusMenuState = {
  isOpen: false,
  isLoading: false,
  error: "",
  anchorRect: null,
  itemId: "",
  itemType: "",
  currentState: "",
  options: [],
};
let effortMenuState = {
  isOpen: false,
  anchorRect: null,
  itemId: "",
  isLoading: false,
};
let timesheetNoticeState = {
  tone: "",
  message: "",
  isLoading: false,
  timerId: null,
};
const EFFORT_HOURS_OPTIONS = Array.from({ length: 16 }, (_item, index) => (index + 1) * 0.5);

const fontReadyPromise = ensureLocalAdoFont();
void init();

async function ensureLocalAdoFont() {
  if (!("FontFace" in window) || document.fonts.check('16px "Bowtie"')) {
    return true;
  }

  const fontUrl = chrome.runtime.getURL("icons/bowtie.woff");
  const response = await fetch(fontUrl);

  if (!response.ok) {
    throw new Error(`Failed to load icon font: HTTP ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const fontFamilies = ["Bowtie", "bowtie"];

  await Promise.all(fontFamilies.map(async (family) => {
    if (document.fonts.check(`16px "${family}"`)) {
      return;
    }

    const font = new FontFace(family, buffer);
    await font.load();
    document.fonts.add(font);
  }));

  return true;
}

function applyPopupMaxHeight() {
  const availableHeight = window.screen?.availHeight || window.innerHeight || 0;

  if (!availableHeight) {
    return;
  }

  document.documentElement.style.setProperty(
    "--popup-max-height",
    `${Math.floor(availableHeight * 0.7)}px`,
  );
}

async function init() {
  try {
    await fontReadyPromise;
  } catch (_error) {
    // Font fallback stays in place if Bowtie cannot be loaded.
  }

  applyPopupMaxHeight();
  currentState = await loadState();
  render();

  refreshButton.addEventListener("click", () => {
    void refreshNow();
  });
  optionsLink?.addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });
  window.addEventListener("resize", applyPopupMaxHeight);
  document.addEventListener("click", handleDocumentClickForMenus);

  for (const button of filterButtons) {
    button.addEventListener("click", () => {
      exitSearchMode();
      currentFilter = button.dataset.filter || DEFAULT_FILTER;
      render();
    });
  }

  searchInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    void runSearchFromInput();
  });
  searchInput?.addEventListener("input", () => {
    updateSearchChrome();
  });

  searchClearButton?.addEventListener("click", () => {
    clearSearchUi();
    render();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) {
      return;
    }

    currentState = {
      ...DEFAULT_STATE,
      ...(changes[STORAGE_KEY].newValue ?? {}),
    };
    render();
    if (isSearchMode && lastSearchQuery) {
      void refetchSearchCatalog({ silent: true });
    }
  });
}

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);

  return {
    ...DEFAULT_STATE,
    ...(stored[STORAGE_KEY] ?? {}),
  };
}

function render() {
  const hasError = Boolean(currentState.lastError);

  countBadge.classList.toggle("hidden", hasError);
  if (!hasError) {
    countBadge.textContent = String(
      isSearchMode ? searchResultItems.length : getFilteredItems().length,
    );
  }

  updateSearchChrome();

  lastUpdated.textContent = formatTimestamp(currentState.lastCheckedAt);

  refreshButton.disabled = isRefreshing;
  refreshButton.setAttribute(
    "aria-label",
    isRefreshing ? "Обновление выполняется" : "Обновить сейчас",
  );
  refreshButton.setAttribute(
    "title",
    isRefreshing ? "Обновление выполняется" : "Обновить сейчас",
  );

  if (currentState.lastError) {
    messageBox.textContent = `Последняя проверка завершилась ошибкой: ${currentState.lastError}`;
    messageBox.classList.add("popup__message--error");
    messageBox.classList.remove("popup__message--success");
    messageBox.classList.remove("hidden");
  } else {
    messageBox.textContent = "";
    messageBox.classList.remove("popup__message--error");
    messageBox.classList.remove("popup__message--success");
    messageBox.classList.add("hidden");
  }

  for (const button of filterButtons) {
    const active = button.dataset.filter === currentFilter;
    button.classList.toggle("popup__filter-button--active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }

  renderTimesheetNotice();

  itemsList.textContent = "";

  if (isSearchMode) {
    if (searchInput) {
      searchInput.disabled = Boolean(isSearchLoading);
    }

    if (isSearchLoading) {
      emptyState.classList.remove("hidden");
      emptyState.classList.remove("popup__empty--error");
      emptyState.textContent = "Загрузка с Azure DevOps…";
      renderStatusMenu();
      return;
    }

    if (searchFetchError) {
      emptyState.classList.remove("hidden");
      emptyState.classList.add("popup__empty--error");
      emptyState.textContent = `Ошибка поиска: ${searchFetchError}`;
      renderStatusMenu();
      return;
    }

    if (!searchResultItems.length) {
      emptyState.classList.remove("hidden");
      emptyState.classList.add("popup__empty--error");
      emptyState.textContent = getSearchEmptyMessage();
      renderStatusMenu();
      return;
    }

    emptyState.classList.add("hidden");
    emptyState.classList.remove("popup__empty--error");

    for (const item of searchResultItems) {
      itemsList.append(createItemElement(item));
    }

    renderStatusMenu();
    return;
  }

  if (searchInput) {
    searchInput.disabled = false;
  }

  const items = getFilteredItems();

  if (!items.length) {
    emptyState.classList.remove("hidden");
    emptyState.classList.remove("popup__empty--error");
    emptyState.textContent = getEmptyStateMessage();
    renderStatusMenu();
    return;
  }

  emptyState.classList.add("hidden");
  emptyState.classList.remove("popup__empty--error");

  for (const group of getGroupedItems(items)) {
    itemsList.append(createGroupElement(group));
  }

  renderStatusMenu();
}

function getFilteredItems() {
  const items = Array.isArray(currentState.items) ? currentState.items : [];

  let filtered = items.filter((item) => normalizeTypeKey(item.type) !== "requirement");

  if (currentFilter === "all") {
    return filtered;
  }

  return filtered.filter((item) => item.stateCategory === currentFilter);
}

function getEmptyStateMessage() {
  if (currentState.lastError) {
    return "Не удалось загрузить work items";
  }

  if (currentFilter === "all") {
    return "Нет активных work items";
  }

  return `Нет work items в категории ${currentFilter}`;
}

function getSearchEmptyMessage() {
  const q = lastSearchQuery.trim();
  return q
    ? `Ошибка: по запросу «${q}» ничего не найдено (заголовок, описание, номер).`
    : "Введите текст и нажмите Enter для поиска.";
}

function updateSearchChrome() {
  const q = searchInput?.value?.trim() ?? "";
  const showClear = Boolean(q || isSearchMode);
  searchClearButton?.classList.toggle("hidden", !showClear);
}

function exitSearchMode() {
  isSearchMode = false;
  lastSearchQuery = "";
  searchResultItems = [];
  searchBackendItems = [];
  isSearchLoading = false;
  searchFetchError = "";
}

function clearSearchUi() {
  exitSearchMode();
  if (searchInput) {
    searchInput.value = "";
  }
}

function computeSearchMatches(rawQuery, sourceItems) {
  const catalog = Array.isArray(sourceItems) ? sourceItems : [];
  const base = catalog.filter((item) => normalizeTypeKey(item.type) !== "requirement");
  const query = String(rawQuery ?? "").trim();
  if (!query) {
    return [];
  }

  const needle = query.toLowerCase();
  const idNeedle = query.replace(/\s+/g, "");
  const idNeedleNoHash = idNeedle.replace(/^#+/, "");

  const matched = base.filter((item) => {
    const title = String(item.title ?? "").toLowerCase();
    const description = String(item.description ?? "").toLowerCase();
    const idStr = String(item.id ?? "");

    if (title.includes(needle) || description.includes(needle)) {
      return true;
    }

    if (idNeedle && idStr.includes(idNeedle)) {
      return true;
    }

    if (idNeedleNoHash && idStr.includes(idNeedleNoHash)) {
      return true;
    }

    return idStr.toLowerCase().includes(needle);
  });

  return matched.sort(compareItemsByCreatedDesc);
}

function compareItemsByCreatedDesc(left, right) {
  const delta = getCreatedTimestamp(right) - getCreatedTimestamp(left);

  if (delta !== 0) {
    return delta;
  }

  return Number(right.id || 0) - Number(left.id || 0);
}

function getCreatedTimestamp(item) {
  return Date.parse(item.createdAt ?? "") || 0;
}

async function runSearchFromInput() {
  const query = searchInput?.value?.trim() ?? "";

  if (!query) {
    clearSearchUi();
    render();
    return;
  }

  lastSearchQuery = query;
  isSearchMode = true;
  await refetchSearchCatalog({ silent: false });
}

async function refetchSearchCatalog(options = {}) {
  const silent = Boolean(options.silent);

  if (!isSearchMode || !lastSearchQuery.trim()) {
    return;
  }

  if (!silent) {
    isSearchLoading = true;
    searchFetchError = "";
    searchResultItems = [];
    searchBackendItems = [];
    render();
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: SEARCH_CATALOG_MESSAGE_TYPE,
      query: lastSearchQuery.trim(),
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Не удалось загрузить данные для поиска.");
    }

    searchBackendItems = Array.isArray(response.items) ? response.items : [];
    searchResultItems = computeSearchMatches(lastSearchQuery, searchBackendItems);
    searchFetchError = "";
  } catch (error) {
    searchFetchError = error instanceof Error ? error.message : String(error);
    searchBackendItems = [];
    searchResultItems = [];
  } finally {
    if (!silent) {
      isSearchLoading = false;
    }
    render();
  }
}

function getGroupedItems(items) {
  const grouped = new Map();

  for (const item of items) {
    const key = normalizeStateCategory(item.stateCategory);

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(item);
  }

  const orderedKeys = [
    ...STATE_GROUP_ORDER.filter((key) => grouped.has(key)),
    ...[...grouped.keys()].filter((key) => !STATE_GROUP_ORDER.includes(key)).sort(),
  ];

  return orderedKeys.map((key) => ({
    key,
    label: STATE_GROUP_LABELS[key] || getDisplayStateName(key),
    items: grouped.get(key).sort(compareItemsByFreshness),
  }));
}

function compareItemsByFreshness(left, right) {
  const delta = getItemTimestamp(right) - getItemTimestamp(left);

  if (delta !== 0) {
    return delta;
  }

  return Number(right.id || 0) - Number(left.id || 0);
}

function getItemTimestamp(item) {
  return Date.parse(item.updatedAt ?? item.createdAt ?? "") || 0;
}

function normalizeStateCategory(stateCategory) {
  return String(stateCategory || "active").toLowerCase();
}

function getDisplayStateName(stateCategory) {
  const normalized = normalizeStateCategory(stateCategory);

  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : "Other";
}

async function refreshNow() {
  if (isRefreshing) {
    return;
  }

  isRefreshing = true;
  render();

  try {
    const response = await chrome.runtime.sendMessage({
      type: REFRESH_MESSAGE_TYPE,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Не удалось выполнить ручное обновление.");
    }
  } finally {
    isRefreshing = false;
    currentState = await loadState();
    if (isSearchMode && lastSearchQuery) {
      await refetchSearchCatalog({ silent: true });
    } else {
      render();
    }
  }
}

function createGroupElement(group) {
  const fragment = document.createDocumentFragment();
  const headerItem = document.createElement("li");
  headerItem.className = "popup__group";

  const title = document.createElement("div");
  title.className = "popup__group-title";
  title.textContent = group.label;

  const count = document.createElement("span");
  count.className = "popup__group-count";
  count.textContent = String(group.items.length);

  headerItem.append(title, count);
  fragment.append(headerItem);

  for (const item of group.items) {
    fragment.append(createItemElement(item));
  }

  return fragment;
}

function createItemElement(item) {
  const listItem = document.createElement("li");
  listItem.className = "popup__item";

  const link = document.createElement("button");
  link.className = "popup__link";
  link.type = "button";
  link.append(createLinkRow(item));
  link.addEventListener("click", async () => {
    await chrome.tabs.create({ url: item.url });
    window.close();
  });

  listItem.append(link, createTimesheetAddButton(item));

  return listItem;
}

function createTimesheetAddButton(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "popup__timesheet-add";
  button.textContent = "+";
  button.setAttribute("aria-label", `Добавить #${item.id} в TimeSheet`);
  button.title = "Добавить время в TimeSheet";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openEffortMenu(item, button);
  });
  return button;
}

function createLinkRow(item) {
  const row = document.createElement("span");
  row.className = "popup__link-main";

  const titleRow = document.createElement("span");
  titleRow.className = "popup__title-row";
  titleRow.append(createTypeIcon(item.type, item), createLinkLabel(item));

  const badges = document.createElement("span");
  badges.className = "popup__item-badges";
  badges.append(createAgeBadge(item), createStateBadge(item));

  row.append(titleRow, badges);
  return row;
}

function createLinkLabel(item) {
  const label = document.createElement("span");
  label.className = "popup__link-label";
  const title = item.title || "";
  const leadingTagsMatch = title.match(/^((?:\[[^\]]+\]\s*)+)/);
  let html = title;

  if (leadingTagsMatch) {
    const leadingTags = leadingTagsMatch[1];
    const titleWithoutPrefix = title.slice(leadingTags.length).trimStart();
    const highlightedTags = leadingTags
      .replace(/\[([^\]]+)\]/g, '<span class="postfix">$&</span>')
      .trim();

    html = titleWithoutPrefix ? `${titleWithoutPrefix} ${highlightedTags}` : highlightedTags;
  }

  label.innerHTML = html;
  return label;
}

function createStateBadge(item) {
  const stateBadge = document.createElement("button");
  stateBadge.type = "button";
  stateBadge.className = `popup__badge popup__badge--${item.stateCategory || "active"}`;
  stateBadge.textContent = item.state || item.stateCategory || "";
  stateBadge.setAttribute("aria-label", `Изменить статус #${item.id}`);
  stateBadge.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openStatusMenu(item, stateBadge);
  });
  return stateBadge;
}

function handleDocumentClickForMenus(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  if (statusMenuState.isOpen && !target.closest(".popup__status-menu")) {
    closeStatusMenu();
  }

  if (effortMenuState.isOpen && !target.closest(".popup__effort-menu")) {
    closeEffortMenu();
  }
}

async function openStatusMenu(item, anchorElement) {
  const rect = anchorElement.getBoundingClientRect();
  statusMenuState = {
    isOpen: true,
    isLoading: true,
    error: "",
    anchorRect: rect,
    itemId: String(item.id),
    itemType: String(item.type ?? ""),
    currentState: String(item.state ?? ""),
    options: [],
  };
  renderStatusMenu();

  try {
    const response = await chrome.runtime.sendMessage({
      type: GET_STATE_OPTIONS_MESSAGE_TYPE,
      workItemType: item.type,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Не удалось загрузить список статусов.");
    }

    statusMenuState = {
      ...statusMenuState,
      isLoading: false,
      options: Array.isArray(response.states) ? response.states : [],
    };
  } catch (error) {
    statusMenuState = {
      ...statusMenuState,
      isLoading: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  renderStatusMenu();
}

function closeStatusMenu() {
  statusMenuState = {
    isOpen: false,
    isLoading: false,
    error: "",
    anchorRect: null,
    itemId: "",
    itemType: "",
    currentState: "",
    options: [],
  };
  renderStatusMenu();
}

function renderStatusMenu() {
  const existing = document.querySelector(".popup__status-menu");
  existing?.remove();

  if (!statusMenuState.isOpen || !statusMenuState.anchorRect) {
    return;
  }

  const menu = document.createElement("div");
  menu.className = "popup__status-menu";
  const top = Math.min(window.innerHeight - 180, statusMenuState.anchorRect.bottom + 6);
  const left = Math.min(window.innerWidth - 200, Math.max(8, statusMenuState.anchorRect.left));
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, left)}px`;

  if (statusMenuState.isLoading) {
    const loading = document.createElement("div");
    loading.className = "popup__status-menu-message";
    loading.textContent = "Загрузка статусов...";
    menu.append(loading);
    document.body.append(menu);
    return;
  }

  if (statusMenuState.error) {
    const error = document.createElement("div");
    error.className = "popup__status-menu-message popup__status-menu-message--error";
    error.textContent = statusMenuState.error;
    menu.append(error);
    document.body.append(menu);
    return;
  }

  const options = statusMenuState.options.filter((option) => option?.name);
  if (!options.length) {
    const empty = document.createElement("div");
    empty.className = "popup__status-menu-message";
    empty.textContent = "Нет доступных статусов";
    menu.append(empty);
    document.body.append(menu);
    return;
  }

  for (const option of options) {
    const stateName = String(option.name);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "popup__status-menu-option";
    button.textContent = stateName;
    if (stateName.toLowerCase() === statusMenuState.currentState.toLowerCase()) {
      button.classList.add("popup__status-menu-option--active");
    }
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await applyWorkItemStateChange(stateName);
    });
    menu.append(button);
  }

  document.body.append(menu);
}

function openEffortMenu(item, anchorElement) {
  closeStatusMenu();
  effortMenuState = {
    isOpen: true,
    anchorRect: anchorElement.getBoundingClientRect(),
    itemId: String(item.id),
    isLoading: false,
  };
  renderEffortMenu();
}

function closeEffortMenu() {
  effortMenuState = {
    isOpen: false,
    anchorRect: null,
    itemId: "",
    isLoading: false,
  };
  renderEffortMenu();
}

function renderEffortMenu() {
  const existing = document.querySelector(".popup__effort-menu");
  existing?.remove();

  if (!effortMenuState.isOpen || !effortMenuState.anchorRect) {
    return;
  }

  const menu = document.createElement("div");
  menu.className = "popup__effort-menu";
  const top = Math.min(window.innerHeight - 220, effortMenuState.anchorRect.bottom + 6);
  const left = Math.min(window.innerWidth - 220, Math.max(8, effortMenuState.anchorRect.left - 182));
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, left)}px`;

  if (effortMenuState.isLoading) {
    const loading = document.createElement("div");
    loading.className = "popup__status-menu-message";
    loading.textContent = "Списание в TimeSheet...";
    menu.append(loading);
    document.body.append(menu);
    return;
  }

  const title = document.createElement("div");
  title.className = "popup__effort-menu-title";
  title.textContent = "Добавить Time в Sheet";
  menu.append(title);

  for (const hours of EFFORT_HOURS_OPTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "popup__effort-option";
    button.textContent = formatHoursLabel(hours);
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await addItemToTimesheet(hours);
    });
    menu.append(button);
  }

  const timesheetLink = document.createElement("a");
  timesheetLink.className = "popup__effort-menu-link";
  timesheetLink.href = "https://hqrndtfsts.avp.ru/TimeSheet/";
  timesheetLink.target = "_blank";
  timesheetLink.rel = "noopener noreferrer";
  timesheetLink.textContent = "Перейти в TimeSheet";
  menu.append(timesheetLink);

  document.body.append(menu);
}

function formatHoursLabel(hours) {
  const value = Number(hours);
  if (Number.isInteger(value)) {
    return `${value} ч`;
  }
  return `${value.toFixed(1).replace(".", ",")}`;
}

async function addItemToTimesheet(hours) {
  if (!effortMenuState.itemId) {
    closeEffortMenu();
    return;
  }

  const targetItemId = effortMenuState.itemId;
  closeEffortMenu();
  setTimesheetNotice({
    tone: "info",
    message: "Списание в TimeSheet...",
    isLoading: true,
  });

  try {
    const response = await chrome.runtime.sendMessage({
      type: ADD_TO_TIMESHEET_MESSAGE_TYPE,
      workItemId: targetItemId,
      hours,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Не удалось добавить запись в TimeSheet.");
    }

    setTimesheetNotice({
      tone: "success",
      message: `Добавлено в TimeSheet: ${formatHoursLabel(hours)}`,
      isLoading: false,
      autoHideMs: 4500,
    });
  } catch (error) {
    setTimesheetNotice({
      tone: "error",
      message: `Ошибка TimeSheet: ${error instanceof Error ? error.message : String(error)}`,
      isLoading: false,
      autoHideMs: 6500,
    });
  }
}

function setTimesheetNotice(options) {
  if (timesheetNoticeState.timerId) {
    clearTimeout(timesheetNoticeState.timerId);
  }

  timesheetNoticeState = {
    tone: String(options.tone ?? "info"),
    message: String(options.message ?? ""),
    isLoading: Boolean(options.isLoading),
    timerId: null,
  };

  if (Number(options.autoHideMs) > 0) {
    timesheetNoticeState.timerId = window.setTimeout(() => {
      timesheetNoticeState = {
        tone: "",
        message: "",
        isLoading: false,
        timerId: null,
      };
      render();
    }, Number(options.autoHideMs));
  }

  render();
}

function renderTimesheetNotice() {
  if (!timesheetStatusBox) {
    return;
  }

  const hasMessage = Boolean(timesheetNoticeState.message);
  timesheetStatusBox.textContent = "";
  timesheetStatusBox.className = "popup__timesheet-notice hidden";

  if (!hasMessage) {
    return;
  }

  const tone = timesheetNoticeState.tone || "info";
  timesheetStatusBox.classList.remove("hidden");
  timesheetStatusBox.classList.add(`popup__timesheet-notice--${tone}`);

  if (timesheetNoticeState.isLoading) {
    const loader = document.createElement("span");
    loader.className = "popup__timesheet-notice-loader";
    loader.setAttribute("aria-hidden", "true");
    timesheetStatusBox.append(loader);
  }

  const text = document.createElement("span");
  text.className = "popup__timesheet-notice-text";
  text.textContent = timesheetNoticeState.message;
  timesheetStatusBox.append(text);
}

async function applyWorkItemStateChange(nextState) {
  if (!statusMenuState.itemId) {
    closeStatusMenu();
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: UPDATE_WORK_ITEM_STATE_MESSAGE_TYPE,
      workItemId: statusMenuState.itemId,
      nextState,
      workItemType: statusMenuState.itemType,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Не удалось сохранить новый статус.");
    }

    patchItemState(
      String(response.workItemId || statusMenuState.itemId),
      String(response.nextState || nextState),
      String(response.nextCategory || ""),
      String(response.updatedAt || new Date().toISOString()),
    );
    setTimesheetNotice({
      tone: "success",
      message: `Статус изменен на ${response.nextState || nextState}`,
      isLoading: false,
      autoHideMs: 4500,
    });
    closeStatusMenu();
    render();
  } catch (error) {
    setTimesheetNotice({
      tone: "error",
      message: `Ошибка обновления статуса: ${error instanceof Error ? error.message : String(error)}`,
      isLoading: false,
      autoHideMs: 6500,
    });
    statusMenuState = {
      ...statusMenuState,
      error: error instanceof Error ? error.message : String(error),
    };
    renderStatusMenu();
  }
}

function patchItemState(itemId, nextState, nextCategory, updatedAt) {
  const applyPatchToList = (items) => {
    if (!Array.isArray(items)) {
      return [];
    }
    return items.map((item) => {
      if (String(item.id) !== String(itemId)) {
        return item;
      }

      return {
        ...item,
        state: nextState,
        stateCategory: nextCategory || item.stateCategory || "active",
        updatedAt,
      };
    });
  };

  currentState = {
    ...currentState,
    items: applyPatchToList(currentState.items),
  };
  searchResultItems = applyPatchToList(searchResultItems);
  searchBackendItems = applyPatchToList(searchBackendItems);
}

function createAgeBadge(item) {
  const ageBadge = document.createElement("span");
  ageBadge.className = "popup__badge popup__badge--age";
  ageBadge.textContent = formatAgeShort(item.updatedAt ?? item.createdAt, currentState.lastCheckedAt);
  return ageBadge;
}

function createTypeIcon(type, item = null) {
  const key = normalizeTypeKey(type);
  const config = WORK_ITEM_TYPE_ICONS[key];

  if (config?.useFont) {
    return createFontTypeIcon(config);
  }

  if (item?.typeIconUrl) {
    return createRemoteTypeIcon(item.typeIconUrl, type);
  }

  const icon = document.createElement("span");
  const fallbackConfig = config ?? {
    className: "popup__type-icon--default",
    svg: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v8a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12V4A1.5 1.5 0 0 1 3 2.5zm0 1A.5.5 0 0 0 2.5 4v8c0 .3.2.5.5.5h10a.5.5 0 0 0 .5-.5V4a.5.5 0 0 0-.5-.5H3zm2 2h6v1H5v-1zm0 2.5h6v1H5V8zm0 2.5h4v1H5v-1z"/></svg>`,
  };

  icon.className = `popup__type-icon ${fallbackConfig.className}`;
  icon.innerHTML = fallbackConfig.svg;
  return icon;
}

function createFontTypeIcon(config) {
  const icon = document.createElement("span");
  icon.className = `popup__type-icon popup__type-glyph ${config.className}`;
  icon.textContent = config.glyph;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function createRemoteTypeIcon(url, type) {
  const icon = document.createElement("span");
  icon.className = "popup__type-icon popup__type-icon--remote";

  const image = document.createElement("img");
  image.className = "popup__type-icon-image";
  image.src = url;
  image.alt = "";
  image.decoding = "async";
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => {
    icon.replaceChildren(createTypeIcon(type));
  }, { once: true });

  icon.append(image);
  return icon;
}

function normalizeTypeKey(type) {
  return String(type ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function formatAgeShort(dateValue, baseValue) {
  if (!dateValue) {
    return "";
  }

  const date = new Date(dateValue);
  const base = baseValue ? new Date(baseValue) : new Date();

  if (Number.isNaN(date.getTime()) || Number.isNaN(base.getTime())) {
    return "";
  }

  const diffMinutes = Math.max(0, Math.floor((base.getTime() - date.getTime()) / 60000));

  if (diffMinutes < 60) {
    return `${Math.max(1, diffMinutes)} м`;
  }

  const hours = Math.floor(diffMinutes / 60);

  if (hours < 24) {
    return `${hours} ч`;
  }

  const days = Math.floor(hours / 24);
  return `${days} д`;
}

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return "ещё не выполнялась";
  }

  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return "ещё не выполнялась";
  }

  const now = new Date();
  const time = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);

  if (isSameLocalDay(date, now)) {
    return time;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (isSameLocalDay(date, yesterday)) {
    return `Вчера ${time}`;
  }

  const datePart = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).format(date);

  return `${datePart} ${time}`;
}

function isSameLocalDay(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}
