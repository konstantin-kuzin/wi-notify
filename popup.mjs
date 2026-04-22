const STORAGE_KEY = "wiState";
const REFRESH_MESSAGE_TYPE = "manual-refresh";
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
const emptyState = document.querySelector("#empty-state");
const itemsList = document.querySelector("#items-list");
const refreshButton = document.querySelector("#refresh-button");
const optionsLink = document.querySelector("#options-link");
const filterButtons = [...document.querySelectorAll("[data-filter]")];
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

  for (const button of filterButtons) {
    button.addEventListener("click", () => {
      currentFilter = button.dataset.filter || DEFAULT_FILTER;
      render();
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) {
      return;
    }

    currentState = {
      ...DEFAULT_STATE,
      ...(changes[STORAGE_KEY].newValue ?? {}),
    };
    render();
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
    countBadge.textContent = String(getFilteredItems().length);
  }

  lastUpdated.textContent = `Последняя проверка: ${formatTimestamp(currentState.lastCheckedAt)}`;

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
    messageBox.classList.remove("hidden");
  } else {
    messageBox.textContent = "";
    messageBox.classList.add("hidden");
  }

  for (const button of filterButtons) {
    const active = button.dataset.filter === currentFilter;
    button.classList.toggle("popup__filter-button--active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }

  const items = getFilteredItems();
  itemsList.textContent = "";

  if (!items.length) {
    emptyState.classList.remove("hidden");
    emptyState.textContent = getEmptyStateMessage();
    return;
  }

  emptyState.classList.add("hidden");

  for (const group of getGroupedItems(items)) {
    itemsList.append(createGroupElement(group));
  }
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
    render();
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

  listItem.append(link);

  return listItem;
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
  const html = title.replace(/\[([^\]]+)\]/g, '<span style="color: var(--soft);">$&</span>');
  label.innerHTML = html;
  return label;
}

function createStateBadge(item) {
  const stateBadge = document.createElement("span");
  stateBadge.className = `popup__badge popup__badge--${item.stateCategory || "active"}`;
  stateBadge.textContent = item.state || item.stateCategory || "";
  return stateBadge;
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

  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}
