import {
  ADO_CONFIG_KEY,
  DEFAULT_ADO_CONFIG,
  loadAdoConfig,
  validateAdoConfig,
  validateReviewConfig,
} from "./ado-config.mjs";
import {
  AI_CONFIG_KEY,
  DEFAULT_AI_CONFIG,
  loadAiConfig,
  validateAiConfig,
} from "./ai-config.mjs";
const form = document.querySelector("#options-form");
const apiRootInput = document.querySelector("#api-root");
const projectInput = document.querySelector("#project");
const iterationPathSelect = document.querySelector("#iteration-path");
const refreshIntervalMinutesInput = document.querySelector("#refresh-interval-minutes");
const saveButton = document.querySelector("#save-button");
const saveStatus = document.querySelector("#save-status");

const reviewForm = document.querySelector("#review-options-form");
const reviewFieldset = document.querySelector("#review-fieldset");
const reviewEnabledInput = document.querySelector("#review-enabled");
const reviewOptionsBody = document.querySelector("#review-options-body");
const reviewProductNameInput = document.querySelector("#review-product-name");
const reviewDesignLeadCombo = document.querySelector("#review-design-lead-combo");
const reviewDesignLeadInput = document.querySelector("#review-design-lead-input");
const reviewDesignLeadList = document.querySelector("#review-design-lead-list");
const reviewDesignLeadValueInput = document.querySelector("#review-design-lead-value");
const reviewDesignLeadNameInput = document.querySelector("#review-design-lead-name");
const reviewDesignLeadAvatarInput = document.querySelector("#review-design-lead-avatar");
const reviewDesignLeadAvatarSlot = document.querySelector("#review-design-lead-avatar-slot");
const reviewParentIdInput = document.querySelector("#review-parent-id");
const reviewProjectInput = document.querySelector("#review-project");
const reviewTemplateTeamInput = document.querySelector("#review-template-team");
const reviewTemplateIdInput = document.querySelector("#review-template-id");
const saveReviewButton = document.querySelector("#save-review-button");
const saveReviewStatus = document.querySelector("#save-review-status");

const aiForm = document.querySelector("#ai-options-form");
const aiBaseUrlInput = document.querySelector("#ai-base-url");
const aiApiKeyInput = document.querySelector("#ai-api-key");
const aiModelInput = document.querySelector("#ai-model");
const aiServicePromptTextarea = document.querySelector("#ai-service-prompt");
const saveAiButton = document.querySelector("#save-ai-button");
const saveAiStatus = document.querySelector("#save-ai-status");

void init();

async function init() {
  const config = await loadAdoConfig();
  apiRootInput.value = config.apiRoot ?? DEFAULT_ADO_CONFIG.apiRoot;
  projectInput.value = config.project ?? DEFAULT_ADO_CONFIG.project;
  refreshIntervalMinutesInput.value = String(
    config.refreshIntervalMinutes ?? DEFAULT_ADO_CONFIG.refreshIntervalMinutes,
  );

  saveButton.addEventListener("click", () => {
    void handleSubmit();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleSubmit();
  });

  apiRootInput.addEventListener("input", () => {
    invalidateWiTypesCache();
    invalidateProjectTagsCache();
    void fetchAndPopulateIterations();
  });

  projectInput.addEventListener("input", () => {
    invalidateWiTypesCache();
    invalidateProjectTagsCache();
    void fetchAndPopulateIterations();
  });

  // Ревью и AI заполняем сразу из storage — не ждём медленный запрос итераций.
  reviewProductNameInput.value = config.reviewProductName ?? DEFAULT_ADO_CONFIG.reviewProductName;
  reviewDesignLeadValueInput.value = config.reviewDesignLead ?? DEFAULT_ADO_CONFIG.reviewDesignLead;
  reviewDesignLeadNameInput.value = config.reviewDesignLeadName ?? DEFAULT_ADO_CONFIG.reviewDesignLeadName;
  reviewDesignLeadAvatarInput.value = config.reviewDesignLeadAvatar ?? DEFAULT_ADO_CONFIG.reviewDesignLeadAvatar;
  reviewDesignLeadInput.value = reviewDesignLeadNameInput.value;
  reviewParentIdInput.value = config.reviewParentId ?? DEFAULT_ADO_CONFIG.reviewParentId;
  reviewProjectInput.value = config.reviewProject ?? DEFAULT_ADO_CONFIG.reviewProject;
  reviewTemplateTeamInput.value = config.reviewTemplateTeam ?? DEFAULT_ADO_CONFIG.reviewTemplateTeam;
  reviewTemplateIdInput.value = config.reviewTemplateId ?? DEFAULT_ADO_CONFIG.reviewTemplateId;
  updateDesignLeadFieldAvatar();
  setupDesignLeadCombo();

  const reviewEnabled = config.reviewEnabled ?? DEFAULT_ADO_CONFIG.reviewEnabled;
  reviewEnabledInput.checked = Boolean(reviewEnabled);
  applyReviewEnabledUi(reviewEnabledInput.checked);

  reviewEnabledInput.addEventListener("change", () => {
    void handleReviewEnabledChange();
  });

  saveReviewButton.addEventListener("click", () => {
    void handleReviewSubmit();
  });

  reviewForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleReviewSubmit();
  });

  const aiConfig = await loadAiConfig();
  aiBaseUrlInput.value = aiConfig.baseUrl ?? DEFAULT_AI_CONFIG.baseUrl;
  aiApiKeyInput.value = aiConfig.apiKey ?? DEFAULT_AI_CONFIG.apiKey;
  aiModelInput.value = aiConfig.model ?? DEFAULT_AI_CONFIG.model;
  aiServicePromptTextarea.value = aiConfig.servicePrompt ?? DEFAULT_AI_CONFIG.servicePrompt;

  saveAiButton.addEventListener("click", () => {
    void handleAiSubmit();
  });

  aiForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleAiSubmit();
  });

  void fetchAndPopulateIterations(config.iterationPath ?? "");
}

async function buildConfigForApi() {
  const stored = await loadAdoConfig();

  return {
    ...stored,
    apiRoot: apiRootInput.value.trim(),
    project: projectInput.value.trim(),
    iterationPath: iterationPathSelect.value.trim(),
    refreshIntervalMinutes: getRefreshIntervalMinutesValue(),
  };
}

async function buildAiConfigForSave() {
  const stored = await loadAiConfig();

  return {
    ...stored,
    baseUrl: aiBaseUrlInput.value.trim(),
    apiKey: aiApiKeyInput.value.trim(),
    model: aiModelInput.value.trim(),
    servicePrompt: aiServicePromptTextarea.value.trim(),
  };
}

async function handleSubmit() {
  saveStatus.textContent = "";
  saveStatus.classList.remove("options__status--ok", "options__status--err");

  const stored = await loadAdoConfig();
  const merged = {
    ...stored,
    apiRoot: apiRootInput.value.trim(),
    project: projectInput.value.trim(),
    iterationPath: iterationPathSelect.value.trim(),
    refreshIntervalMinutes: getRefreshIntervalMinutesValue(),
  };

  const errors = validateAdoConfig(merged);

  if (errors.length > 0) {
    saveStatus.textContent = errors.join(" ");
    saveStatus.classList.add("options__status--err");
    return;
  }

  try {
    await chrome.storage.local.set({
      [ADO_CONFIG_KEY]: merged,
    });
    console.log('Config saved successfully:', merged);
  } catch (error) {
    console.error('Failed to save config:', error);
    saveStatus.textContent = "Ошибка сохранения: " + error.message;
    saveStatus.classList.add("options__status--err");
    return;
  }

  await requestDevAzureHostPermissionIfNeeded(merged.apiRoot);

  // Reload the config to verify it's saved and update form values
  const savedConfig = await loadAdoConfig();
  console.log('Loaded config after save:', savedConfig);
  apiRootInput.value = savedConfig.apiRoot;
  projectInput.value = savedConfig.project;
  refreshIntervalMinutesInput.value = String(savedConfig.refreshIntervalMinutes);
  await fetchAndPopulateIterations(savedConfig.iterationPath ?? "");
  console.log('Form values set to:', apiRootInput.value, projectInput.value, iterationPathSelect.value);

  await refreshCustomButtonTypeFields();

  saveStatus.textContent = "Сохранено. Список work items обновится автоматически.";
  saveStatus.classList.add("options__status--ok");
}

async function handleReviewSubmit() {
  saveReviewStatus.textContent = "";
  saveReviewStatus.classList.remove("options__status--ok", "options__status--err");

  const stored = await loadAdoConfig();
  const merged = {
    ...stored,
    reviewEnabled: reviewEnabledInput.checked,
    reviewProductName: reviewProductNameInput.value.trim(),
    reviewDesignLead: reviewDesignLeadValueInput.value.trim(),
    reviewDesignLeadName: reviewDesignLeadNameInput.value.trim(),
    reviewDesignLeadAvatar: reviewDesignLeadAvatarInput.value.trim(),
    reviewParentId: reviewParentIdInput.value.trim(),
    reviewProject: reviewProjectInput.value.trim(),
    reviewTemplateTeam: reviewTemplateTeamInput.value.trim(),
    reviewTemplateId: reviewTemplateIdInput.value.trim(),
    // Поля без UI — хранятся хардкодом из дефолтов конфига.
    reviewWorkItemType: DEFAULT_ADO_CONFIG.reviewWorkItemType,
    reviewDesignTypes: DEFAULT_ADO_CONFIG.reviewDesignTypes,
    reviewPlaceholderText: DEFAULT_ADO_CONFIG.reviewPlaceholderText,
  };

  const errors = validateReviewConfig(merged);

  if (errors.length > 0) {
    saveReviewStatus.textContent = errors.join(" ");
    saveReviewStatus.classList.add("options__status--err");
    return;
  }

  try {
    await chrome.storage.local.set({
      [ADO_CONFIG_KEY]: merged,
    });
  } catch (error) {
    saveReviewStatus.textContent = "Ошибка сохранения: " + error.message;
    saveReviewStatus.classList.add("options__status--err");
    return;
  }

  saveReviewStatus.textContent = "Настройки задачи на ревью сохранены.";
  saveReviewStatus.classList.add("options__status--ok");
}

/**
 * Сворачивает/разворачивает поля блока «Задача на ревью» по состоянию тоггла.
 * @param {boolean} enabled
 */
function applyReviewEnabledUi(enabled) {
  reviewFieldset.classList.toggle("options__fieldset--collapsed", !enabled);
  reviewOptionsBody.hidden = !enabled;
  reviewEnabledInput.setAttribute("aria-checked", enabled ? "true" : "false");
}

/**
 * Тоггл сразу пишется в storage — иначе при выключении нельзя сохранить через скрытую кнопку.
 */
async function handleReviewEnabledChange() {
  const enabled = reviewEnabledInput.checked;
  applyReviewEnabledUi(enabled);
  saveReviewStatus.textContent = "";
  saveReviewStatus.classList.remove("options__status--ok", "options__status--err");

  try {
    const stored = await loadAdoConfig();
    await chrome.storage.local.set({
      [ADO_CONFIG_KEY]: {
        ...stored,
        reviewEnabled: enabled,
      },
    });
  } catch (error) {
    // При ошибке возвращаем тоггл и раскрытие к прежнему состоянию.
    reviewEnabledInput.checked = !enabled;
    applyReviewEnabledUi(reviewEnabledInput.checked);
    saveReviewStatus.textContent = "Ошибка сохранения: " + error.message;
    saveReviewStatus.classList.add("options__status--err");
  }
}

// --- Дизайн-лид: комбобокс с поиском пользователей -------------------------

const SEARCH_IDENTITIES_MESSAGE_TYPE = "search-identities";

function requestSearchIdentities(query) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: SEARCH_IDENTITIES_MESSAGE_TYPE, query },
      (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(response);
      },
    );
  });
}

function getInitials(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return "";
  }
  const first = parts[0][0] ?? "";
  const second = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + second).toUpperCase();
}

/** Создаёт кружок-аватар: инициалы + картинка поверх (если загрузится). */
function createAvatar(name, avatarUrl) {
  const wrap = document.createElement("span");
  wrap.className = "options__avatar";

  const initials = document.createElement("span");
  initials.className = "options__avatar-initials";
  initials.textContent = getInitials(name);
  wrap.appendChild(initials);

  if (avatarUrl) {
    const img = document.createElement("img");
    img.className = "options__avatar-img";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => img.remove());
    img.src = avatarUrl;
    wrap.appendChild(img);
  }

  return wrap;
}

/** Обновляет аватар выбранного дизайн-лида в самом поле. */
function updateDesignLeadFieldAvatar() {
  reviewDesignLeadAvatarSlot.innerHTML = "";
  const name = reviewDesignLeadNameInput.value.trim();

  if (!name) {
    reviewDesignLeadCombo.classList.remove("options__combo--has-avatar");
    return;
  }

  reviewDesignLeadAvatarSlot.appendChild(
    createAvatar(name, reviewDesignLeadAvatarInput.value.trim()),
  );
  reviewDesignLeadCombo.classList.add("options__combo--has-avatar");
}

function clearDesignLeadSelection() {
  reviewDesignLeadValueInput.value = "";
  reviewDesignLeadNameInput.value = "";
  reviewDesignLeadAvatarInput.value = "";
  updateDesignLeadFieldAvatar();
}

function hideDesignLeadList() {
  reviewDesignLeadList.hidden = true;
  reviewDesignLeadList.innerHTML = "";
  reviewDesignLeadInput.setAttribute("aria-expanded", "false");
}

function renderDesignLeadList(items) {
  reviewDesignLeadList.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "options__combo-empty";
    empty.textContent = "Пользователи не найдены";
    reviewDesignLeadList.appendChild(empty);
  } else {
    for (const item of items) {
      const li = document.createElement("li");
      li.className = "options__combo-item";
      li.setAttribute("role", "option");

      li.appendChild(createAvatar(item.displayName || item.uniqueName, item.avatarUrl));

      const text = document.createElement("div");
      text.className = "options__combo-item-text";

      const name = document.createElement("span");
      name.className = "options__combo-item-name";
      name.textContent = item.displayName || item.uniqueName;
      text.appendChild(name);

      if (item.uniqueName) {
        const sub = document.createElement("span");
        sub.className = "options__combo-item-sub";
        sub.textContent = item.uniqueName;
        text.appendChild(sub);
      }

      li.appendChild(text);

      // mousedown, чтобы выбор сработал раньше blur поля.
      li.addEventListener("mousedown", (event) => {
        event.preventDefault();
        reviewDesignLeadValueInput.value = item.assignedTo || item.displayName;
        reviewDesignLeadNameInput.value = item.displayName || item.uniqueName;
        reviewDesignLeadAvatarInput.value = item.avatarUrl || "";
        reviewDesignLeadInput.value = reviewDesignLeadNameInput.value;
        updateDesignLeadFieldAvatar();
        hideDesignLeadList();
      });

      reviewDesignLeadList.appendChild(li);
    }
  }

  reviewDesignLeadList.hidden = false;
  reviewDesignLeadInput.setAttribute("aria-expanded", "true");
}

function setupDesignLeadCombo() {
  let debounceId = null;
  let requestSeq = 0;

  reviewDesignLeadInput.addEventListener("input", () => {
    const query = reviewDesignLeadInput.value.trim();

    // Пустое поле — снимаем назначение.
    if (!query) {
      clearDesignLeadSelection();
      hideDesignLeadList();
      return;
    }

    if (query.length < 2) {
      hideDesignLeadList();
      return;
    }

    if (debounceId !== null) {
      window.clearTimeout(debounceId);
    }

    debounceId = window.setTimeout(async () => {
      const seq = ++requestSeq;
      try {
        const response = await requestSearchIdentities(query);
        if (seq !== requestSeq) {
          return; // пришёл ответ на устаревший запрос
        }
        if (response?.ok) {
          renderDesignLeadList(response.results ?? []);
        } else {
          renderDesignLeadList([]);
        }
      } catch (_error) {
        if (seq === requestSeq) {
          hideDesignLeadList();
        }
      }
    }, 300);
  });

  // При потере фокуса возвращаем в поле подтверждённое имя и прячем список.
  reviewDesignLeadInput.addEventListener("blur", () => {
    window.setTimeout(() => {
      reviewDesignLeadInput.value = reviewDesignLeadNameInput.value;
      hideDesignLeadList();
    }, 150);
  });
}

async function handleAiSubmit() {
  saveAiStatus.textContent = "";
  saveAiStatus.classList.remove("options__status--ok", "options__status--err");

  const merged = await buildAiConfigForSave();
  const errors = validateAiConfig(merged);

  if (errors.length > 0) {
    saveAiStatus.textContent = errors.join(" ");
    saveAiStatus.classList.add("options__status--err");
    return;
  }

  try {
    await chrome.storage.local.set({
      [AI_CONFIG_KEY]: merged,
    });
    console.log('AI Config saved successfully:', merged);
  } catch (error) {
    console.error('Failed to save AI config:', error);
    saveAiStatus.textContent = "Ошибка сохранения AI настроек: " + error.message;
    saveAiStatus.classList.add("options__status--err");
    return;
  }

  // Request host permission for the AI API base URL if not already granted
  try {
    await requestAiHostPermissionIfNeeded(merged.baseUrl);
  } catch (error) {
    console.error('AI host permission request failed:', error);
    saveAiStatus.textContent = error instanceof Error
      ? error.message
      : String(error);
    saveAiStatus.classList.add("options__status--err");
    return;
  }

  saveAiStatus.textContent = "AI настройки сохранены, доступ к AI API выдан.";
  saveAiStatus.classList.add("options__status--ok");
}

async function requestDevAzureHostPermissionIfNeeded(apiRoot) {
  let hostname = "";

  try {
    hostname = new URL(apiRoot).hostname;
  } catch (_error) {
    return;
  }

  if (hostname !== "dev.azure.com") {
    return;
  }

  const origins = ["https://dev.azure.com/*"];
  const already = await chrome.permissions.contains({ origins });

  if (already) {
    return;
  }

  await chrome.permissions.request({ origins });
}

async function requestAiHostPermissionIfNeeded(baseUrl) {
  let originPattern = "";

  try {
    const parsedUrl = new URL(baseUrl);
    originPattern = `${parsedUrl.protocol}//${parsedUrl.host}/*`;
  } catch (_error) {
    return;
  }

  const origins = [originPattern];
  const already = await chrome.permissions.contains({ origins });

  if (already) {
    console.log("[WI Notify AI] AI host permission already granted.", { origins });
    return;
  }

  console.log("[WI Notify AI] Requesting AI host permission.", { origins });
  const granted = await chrome.permissions.request({ origins });
  console.log("[WI Notify AI] AI host permission request result.", { origins, granted });

  if (!granted) {
    throw new Error(`Не выдан доступ к ${originPattern}. Разрешите host permission для AI API.`);
  }
}

/**
 * @param {string} [preferredPath] — значение из storage; если не передано, сохраняем текущий выбор в select до перерисовки.
 */
async function fetchAndPopulateIterations(preferredPath) {
  const apiRoot = apiRootInput.value.trim();
  const project = projectInput.value.trim();

  const previousSelection =
    typeof preferredPath === "string"
      ? preferredPath.trim()
      : iterationPathSelect.value.trim();

  if (!apiRoot || !project) {
    iterationPathSelect.innerHTML = '<option value="">All</option>';
    return;
  }

  try {
    const url = `${apiRoot}/${project}/_apis/wit/classificationnodes/iterations?api-version=6.0-preview&$depth=10`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log("[ado API options]", url, data);
    const iterations = flattenIterations(data.children || []);
    const paths = new Set(iterations.map((iter) => iter.path));

    iterationPathSelect.innerHTML = '<option value="">All</option>';
    for (const iter of iterations) {
      const opt = document.createElement("option");
      opt.value = iter.path;
      opt.textContent = iter.name;
      iterationPathSelect.appendChild(opt);
    }

    if (previousSelection && !paths.has(previousSelection)) {
      const opt = document.createElement("option");
      opt.value = previousSelection;
      opt.textContent = previousSelection;
      iterationPathSelect.appendChild(opt);
    }

    iterationPathSelect.value = previousSelection || "";
  } catch (error) {
    console.error('Failed to fetch iterations:', error);
    iterationPathSelect.innerHTML = '<option value="">All</option>';
  }
}

function flattenIterations(nodes, result = []) {
  for (const node of nodes) {
    result.push({ name: node.name, path: node.path });
    if (node.children) {
      flattenIterations(node.children, result);
    }
  }
  return result;
}

function getRefreshIntervalMinutesValue() {
  return Number.parseInt(refreshIntervalMinutesInput.value, 10);
}


const CUSTOM_MSG = {
  types: "get-wi-types",
  tags: "get-wi-tags",
  relations: "get-wi-relation-types",
  search: "search-work-items",
};

function sendBg(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response ?? { ok: false, error: "Пустой ответ" });
    });
  });
}

async function saveCustomButtons(buttons) {
  const stored = await loadAdoConfig();
  const next = { ...stored, customReviewButtons: buttons };
  await chrome.storage.local.set({ [ADO_CONFIG_KEY]: next });
}

let wiTypesCache = null;
/** Проект, для которого закэшированы типы (поле «Проект» в основных настройках). */
let wiTypesCacheProject = "";
let relationTypesCache = null;
let projectTagsCache = null;
let projectTagsCacheProject = "";

function getMainSettingsProject() {
  return projectInput.value.trim();
}

function invalidateWiTypesCache() {
  wiTypesCache = null;
  wiTypesCacheProject = "";
}

function invalidateProjectTagsCache() {
  projectTagsCache = null;
  projectTagsCacheProject = "";
}

/** Типы WI только из проекта основных настроек. */
async function getWiTypes({ force = false } = {}) {
  const project = getMainSettingsProject();
  if (!force && wiTypesCache && wiTypesCacheProject === project) {
    return wiTypesCache;
  }
  const r = await sendBg({ type: CUSTOM_MSG.types, project });
  wiTypesCache = (r.ok ? r.results : [])
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "ru", { sensitivity: "base" }));
  wiTypesCacheProject = project;
  return wiTypesCache;
}
async function getRelationTypes() {
  if (!relationTypesCache) {
    const r = await sendBg({ type: CUSTOM_MSG.relations });
    relationTypesCache = r.ok ? r.results : [];
  }
  return relationTypesCache;
}
async function getProjectTags() {
  const project = getMainSettingsProject();
  if (projectTagsCache && projectTagsCacheProject === project) {
    return projectTagsCache;
  }
  const r = await sendBg({ type: CUSTOM_MSG.tags, project });
  projectTagsCache = r.ok ? r.results : [];
  projectTagsCacheProject = project;
  return projectTagsCache;
}

/**
 * После смены проекта в основных настройках — обновить «Тип Wi» и
 * убрать чипы «Показывать для типов», которых нет в новом проекте.
 */
async function refreshCustomButtonTypeFields() {
  invalidateWiTypesCache();
  const types = await getWiTypes({ force: true });
  const typeNames = new Set(types.map((t) => t.name));

  for (const card of document.querySelectorAll("#custom-buttons-list [data-card]")) {
    const select = card.querySelector('[data-field="wiType"]');
    if (select) {
      const selected = select.value;
      await fillWiTypeSelect(select, typeNames.has(selected) ? selected : "");
    }
    for (const chip of card.querySelectorAll("[data-types-chips] .custom-tags__chip")) {
      if (!typeNames.has(chip.dataset.value)) chip.remove();
    }
  }
}

function readCardConfig(card) {
  const val = (sel) => card.querySelector(sel);
  const wiSelect = val('[data-field="wiType"]');
  const selectedType = wiSelect?.value ?? "";
  const iconUrl = wiSelect?.selectedOptions?.[0]?.dataset?.iconUrl ?? "";
  const iconColor = wiSelect?.selectedOptions?.[0]?.dataset?.color ?? "";

  const tags = Array.from(card.querySelectorAll("[data-tags-chips] .custom-tags__chip"))
    .map((chip) => chip.dataset.value)
    .filter(Boolean);

  const showForTypes = Array.from(card.querySelectorAll("[data-types-chips] .custom-tags__chip"))
    .map((chip) => chip.dataset.value)
    .filter(Boolean);

  const links = Array.from(card.querySelectorAll("[data-link-card]"))
    .map((linkCard) => ({
      relType: linkCard.querySelector("[data-link-type]")?.value ?? "",
      targetId: Number(linkCard.dataset.targetId || 0),
      targetTitle: linkCard.dataset.targetTitle || "",
      toParent: linkCard.querySelector("[data-link-to-parent]")?.checked ?? false,
    }))
    .filter((l) => l.relType && (l.toParent || l.targetId > 0));

  return {
    id: card.dataset.id,
    name: val('[data-field="name"]').value.trim(),
    wiType: selectedType,
    wiTypeIcon: { url: iconUrl, color: iconColor },
    title: val('[data-field="title"]').value.trim(),
    titleFromParent: val('[data-field="titleFromParent"]').checked,
    assignedTo: card.dataset.assignedTo || "",
    assignedToName: card.dataset.assignedToName || "",
    assignedToAvatar: card.dataset.assignedToAvatar || "",
    description: val('[data-field="description"]').value,
    descriptionFromParent: val('[data-field="descriptionFromParent"]').checked,
    tags,
    showForTypes,
    links,
  };
}

async function fillWiTypeSelect(select, selected) {
  const types = await getWiTypes();
  select.innerHTML = "";
  for (const t of types) {
    const opt = document.createElement("option");
    opt.value = t.name;
    opt.textContent = t.name;
    opt.dataset.iconUrl = t.iconUrl || "";
    opt.dataset.color = t.color || "";
    if (t.name === selected) opt.selected = true;
    select.appendChild(opt);
  }
}

/**
 * Комбобокс «Тип связи» с поиском по мере ввода (как «Назначить на»).
 * Выбранный тип хранится в linkCard.dataset.relType (referenceName).
 */
/** Наполняет нативный select типов связи (значение — referenceName, подпись — name). */
async function fillRelationSelect(select, selected) {
  const rels = await getRelationTypes();
  select.innerHTML = "";
  for (const r of rels) {
    const opt = document.createElement("option");
    opt.value = r.referenceName;
    opt.textContent = r.name;
    if (r.referenceName === selected) opt.selected = true;
    select.appendChild(opt);
  }
}

function addTagChip(card, value) {
  const name = String(value ?? "").trim();
  if (!name) return false;
  const chips = card.querySelector("[data-tags-chips]");
  if (!chips) return false;
  if (Array.from(chips.children).some((c) => c.dataset.value?.toLowerCase() === name.toLowerCase())) return false;
  const chip = document.createElement("span");
  chip.className = "custom-tags__chip";
  chip.dataset.value = name;
  const text = document.createElement("span");
  text.textContent = name;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "×";
  remove.addEventListener("click", () => chip.remove());
  chip.append(text, remove);
  chips.appendChild(chip);
  return true;
}

function wireTagsInput(card) {
  const input = card.querySelector("[data-tags-input]");
  const list = card.querySelector("[data-tags-list]");

  // Фиксируем всё, что введено (в т.ч. несколько тэгов через запятую).
  const commit = () => {
    let added = false;
    for (const part of String(input.value).split(",")) {
      if (addTagChip(card, part)) added = true;
    }
    input.value = "";
    if (list) list.hidden = true;
    return added;
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    }
  });
  // Если пользователь ушёл из поля с недобавленным текстом — добавим как тэг.
  input.addEventListener("blur", () => {
    if (input.value.trim()) commit();
  });
  input.addEventListener("input", async () => {
    if (!list) return;
    const q = input.value.trim().toLowerCase();
    list.innerHTML = "";
    if (!q) { list.hidden = true; return; }
    const tags = (await getProjectTags()).filter((t) => t.toLowerCase().includes(q)).slice(0, 8);
    for (const t of tags) {
      const li = document.createElement("li");
      li.className = "options__combo-item";
      li.setAttribute("role", "option");
      li.textContent = t;
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        addTagChip(card, t);
        input.value = "";
        list.hidden = true;
      });
      list.appendChild(li);
    }
    list.hidden = tags.length === 0;
  });
}

/** Чип типа задачи в поле «Показывать для типов» (переиспользует стиль тэгов). */
function addTypeChip(card, value) {
  const name = String(value ?? "").trim();
  if (!name) return false;
  const chips = card.querySelector("[data-types-chips]");
  if (!chips) return false;
  if (Array.from(chips.children).some((c) => c.dataset.value?.toLowerCase() === name.toLowerCase())) return false;
  const chip = document.createElement("span");
  chip.className = "custom-tags__chip";
  chip.dataset.value = name;
  const text = document.createElement("span");
  text.textContent = name;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "×";
  remove.addEventListener("click", () => chip.remove());
  chip.append(text, remove);
  chips.appendChild(chip);
  return true;
}

/**
 * «Показывать для типов»: мультивыбор с поиском по типам проекта. В отличие от
 * тэгов, добавляем только реально существующие типы (иначе фильтр не совпадёт).
 */
function wireTypesInput(card) {
  const input = card.querySelector("[data-types-input]");
  const list = card.querySelector("[data-types-list]");
  if (!input || !list) return;

  const chosenLower = () => new Set(
    Array.from(card.querySelectorAll("[data-types-chips] .custom-tags__chip"))
      .map((c) => (c.dataset.value || "").toLowerCase()),
  );

  const render = async () => {
    const q = input.value.trim().toLowerCase();
    const chosen = chosenLower();
    // Полный список типов проекта (как в «Тип Wi»), без лимита —
    // уже выбранные чипы просто скрываем из выпадающего списка.
    const names = (await getWiTypes()).map((t) => t.name)
      .filter((t) => !chosen.has(t.toLowerCase()) && (!q || t.toLowerCase().includes(q)));
    list.innerHTML = "";
    for (const t of names) {
      const li = document.createElement("li");
      li.className = "options__combo-item";
      li.setAttribute("role", "option");
      li.textContent = t;
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        addTypeChip(card, t);
        input.value = "";
        list.hidden = true;
      });
      list.appendChild(li);
    }
    list.hidden = names.length === 0;
  };

  input.addEventListener("focus", render);
  input.addEventListener("input", render);
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    const names = (await getWiTypes()).map((t) => t.name);
    const pick = names.find((t) => t.toLowerCase() === q) || names.find((t) => t.toLowerCase().includes(q));
    if (pick) {
      addTypeChip(card, pick);
      input.value = "";
      list.hidden = true;
    }
  });
  input.addEventListener("blur", () => {
    window.setTimeout(() => { list.hidden = true; }, 150);
  });
}

async function addLinkCard(card, link = null) {
  const tpl = document.getElementById("custom-link-card-template");
  const node = tpl.content.firstElementChild.cloneNode(true);
  await fillRelationSelect(node.querySelector("[data-link-type]"), link?.relType ?? "");

  const input = node.querySelector("[data-wi-input]");
  const listEl = node.querySelector("[data-wi-list]");
  if (link?.targetId) {
    node.dataset.targetId = String(link.targetId);
    node.dataset.targetTitle = link.targetTitle ?? "";
    input.value = `#${link.targetId} ${link.targetTitle ?? ""}`.trim();
  }

  // Чекбокс «Привязать к родительской задаче»: цель связи — исходная задача,
  // поэтому поиск Wi дизейблим (аналогично «Взять название из родителя»).
  const toParent = node.querySelector("[data-link-to-parent]");
  const syncParentMode = () => {
    input.disabled = toParent.checked;
    if (toParent.checked) {
      listEl.hidden = true;
    }
  };
  toParent.checked = Boolean(link?.toParent);
  toParent.addEventListener("change", syncParentMode);
  syncParentMode();

  let searchTimer = null;
  input.addEventListener("input", () => {
    node.dataset.targetId = "";
    if (searchTimer) clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) { listEl.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      const r = await sendBg({ type: CUSTOM_MSG.search, query: q });
      const results = r.ok ? r.results : [];
      console.log("[WI-CUSTOM] поиск Wi:", { query: q, ok: r.ok, count: results.length, debug: r.debug, error: r.error });
      listEl.innerHTML = "";
      for (const wi of results) {
        const li = document.createElement("li");
        li.className = "options__combo-item";
        li.setAttribute("role", "option");
        const proj = wi.project ? ` · ${wi.project}` : "";
        li.textContent = `#${wi.id} · ${wi.type}${proj} · ${wi.title}`;
        li.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          node.dataset.targetId = String(wi.id);
          node.dataset.targetTitle = wi.title;
          input.value = `#${wi.id} ${wi.title}`;
          listEl.hidden = true;
        });
        listEl.appendChild(li);
      }
      listEl.hidden = results.length === 0;
    }, 250);
  });

  node.querySelector("[data-link-remove]").addEventListener("click", () => node.remove());
  card.querySelector("[data-links]").appendChild(node);
}

/** Обновляет аватар выбранного исполнителя в поле карточки (по аналогии с design-лидом). */
function updateAssigneeAvatar(card) {
  const slot = card.querySelector("[data-assignee-avatar]");
  const combo = card.querySelector("[data-assignee-combo]");
  slot.innerHTML = "";
  const name = card.dataset.assignedToName || "";

  if (!name) {
    combo.classList.remove("options__combo--has-avatar");
    return;
  }

  slot.appendChild(createAvatar(name, card.dataset.assignedToAvatar || ""));
  combo.classList.add("options__combo--has-avatar");
}

/**
 * Комбобокс «Назначить на» карточки: поля identity те же, что использует
 * существующий комбобокс дизайн-лида (renderDesignLeadList) — assignedTo/displayName/avatarUrl.
 */
function wireAssignee(card, preset) {
  const input = card.querySelector("[data-assignee-input]");
  const listEl = card.querySelector("[data-assignee-list]");

  if (preset?.assignedTo) {
    card.dataset.assignedTo = preset.assignedTo;
    card.dataset.assignedToName = preset.assignedToName ?? "";
    card.dataset.assignedToAvatar = preset.assignedToAvatar ?? "";
    input.value = preset.assignedToName || preset.assignedTo;
  }
  updateAssigneeAvatar(card);

  let timer = null;
  input.addEventListener("input", () => {
    card.dataset.assignedTo = "";
    card.dataset.assignedToName = "";
    card.dataset.assignedToAvatar = "";
    updateAssigneeAvatar(card);
    if (timer) clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { listEl.hidden = true; return; }
    timer = setTimeout(async () => {
      const r = await sendBg({ type: SEARCH_IDENTITIES_MESSAGE_TYPE, query: q });
      const results = r.ok ? r.results : [];
      listEl.innerHTML = "";
      for (const person of results) {
        const li = document.createElement("li");
        li.className = "options__combo-item";
        li.setAttribute("role", "option");
        li.textContent = person.displayName || person.uniqueName || "";
        li.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          card.dataset.assignedTo = person.assignedTo || person.displayName || "";
          card.dataset.assignedToName = person.displayName || person.uniqueName || "";
          card.dataset.assignedToAvatar = person.avatarUrl || "";
          input.value = card.dataset.assignedToName;
          updateAssigneeAvatar(card);
          listEl.hidden = true;
        });
        listEl.appendChild(li);
      }
      listEl.hidden = results.length === 0;
    }, 250);
  });
}

async function buildCard(config = null) {
  const tpl = document.getElementById("custom-button-card-template");
  const card = tpl.content.firstElementChild.cloneNode(true);
  card.dataset.id = config?.id ?? `crb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  await fillWiTypeSelect(card.querySelector('[data-field="wiType"]'), config?.wiType ?? "");
  card.querySelector('[data-field="name"]').value = config?.name ?? "";
  card.querySelector('[data-field="title"]').value = config?.title ?? "";
  card.querySelector('[data-field="description"]').value = config?.description ?? "";

  const titleInput = card.querySelector('[data-field="title"]');
  const fromParent = card.querySelector('[data-field="titleFromParent"]');
  fromParent.checked = Boolean(config?.titleFromParent);
  const syncTitleDisabled = () => { titleInput.disabled = fromParent.checked; };
  fromParent.addEventListener("change", syncTitleDisabled);
  syncTitleDisabled();

  const descInput = card.querySelector('[data-field="description"]');
  const descFromParent = card.querySelector('[data-field="descriptionFromParent"]');
  descFromParent.checked = Boolean(config?.descriptionFromParent);
  const syncDescDisabled = () => { descInput.disabled = descFromParent.checked; };
  descFromParent.addEventListener("change", syncDescDisabled);
  syncDescDisabled();

  wireAssignee(card, config);
  wireTagsInput(card);
  for (const t of config?.tags ?? []) addTagChip(card, t);
  wireTypesInput(card);
  for (const t of config?.showForTypes ?? []) addTypeChip(card, t);
  for (const l of config?.links ?? []) await addLinkCard(card, l);

  card.querySelector("[data-add-link]").addEventListener("click", () => addLinkCard(card));

  card.querySelector("[data-save]").addEventListener("click", async () => {
    const status = card.querySelector("[data-status]");
    const cfg = readCardConfig(card);
    if (!cfg.name) { status.textContent = "Укажите название кнопки"; return; }
    if (!cfg.wiType) { status.textContent = "Выберите тип Wi"; return; }
    if (!cfg.titleFromParent && !cfg.title) { status.textContent = "Укажите название задачи или включите «из исходной задачи»"; return; }

    const stored = await loadAdoConfig();
    const buttons = Array.isArray(stored.customReviewButtons) ? [...stored.customReviewButtons] : [];
    const idx = buttons.findIndex((b) => b.id === cfg.id);
    if (idx >= 0) buttons[idx] = cfg; else buttons.push(cfg);
    await saveCustomButtons(buttons);
    status.textContent = "Сохранено ✓";
    setTimeout(() => { status.textContent = ""; }, 2000);
  });

  card.querySelector("[data-remove]").addEventListener("click", async () => {
    const stored = await loadAdoConfig();
    const buttons = (stored.customReviewButtons ?? []).filter((b) => b.id !== card.dataset.id);
    await saveCustomButtons(buttons);
    card.remove();
  });

  return card;
}

async function initCustomButtons() {
  const list = document.getElementById("custom-buttons-list");
  const addBtn = document.getElementById("add-custom-button");
  if (!list || !addBtn) return;

  const stored = await loadAdoConfig();
  for (const cfg of stored.customReviewButtons ?? []) {
    list.appendChild(await buildCard(cfg));
  }
  addBtn.addEventListener("click", async () => {
    list.appendChild(await buildCard(null));
  });
}

void initCustomButtons();
