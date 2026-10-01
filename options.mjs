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
  FIXED_AI_BASE_URL,
  FIXED_AI_MODEL,
  SHOW_AI_SERVICE_PROMPT,
  applyFixedAiProvider,
  loadRawAiConfig,
  validateAiConfig,
} from "./ai-config.mjs";
import { fetchAiModels } from "./ai-api.mjs";
const form = document.querySelector("#options-form");
const apiRootInput = document.querySelector("#api-root");
const projectInput = document.querySelector("#project");
const workItemQuerySelect = document.querySelector("#work-item-query");
const workItemQueryHint = document.querySelector("#work-item-query-hint");
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
const aiFieldset = document.querySelector("#ai-fieldset");
const aiEnabledInput = document.querySelector("#ai-enabled");
const aiOptionsBody = document.querySelector("#ai-options-body");
const aiUseFixedProviderInput = document.querySelector("#ai-use-fixed-provider");
const aiBaseUrlInput = document.querySelector("#ai-base-url");
const aiApiKeyInput = document.querySelector("#ai-api-key");
const aiModelSelect = document.querySelector("#ai-model");
const aiModelRefreshButton = document.querySelector("#ai-model-refresh");
const aiServicePromptTextarea = document.querySelector("#ai-service-prompt");
const saveAiButton = document.querySelector("#save-ai-button");
const saveAiStatus = document.querySelector("#save-ai-status");

/** Кэш последнего успешно загруженного списка моделей провайдера. */
let aiModelsCache = null;
const LIST_QUERIES_MESSAGE_TYPE = "list-work-item-queries";
const WORK_ITEM_QUERY_HINT = "Если Query не выбран, в\u00A0popup попадают все ваши задачи. Выбранный Query заменяет эту выборку.";
let queryReloadTimer = null;
/** Проект, для которого список Query уже успешно загружался. */
let queriesLoadedForProject = "";
/** Выбор, который нужно сохранить, пока в селекте показан Loading. */
let querySelectionPending = null;
let queryFetchToken = 0;

/** Таймеры скрытия успешного статуса, чтобы повторное сообщение их отменяло. */
const statusFadeState = new WeakMap();

/**
 * Единый статус сохранения рядом с кнопкой.
 * Успешное сообщение держится 4 с и гаснет за 1 с.
 * @param {HTMLElement | null} el
 * @param {string} message
 * @param {"ok" | "err" | ""} [kind]
 */
function setOptionsStatus(el, message, kind = "") {
  if (!el) return;

  const prev = statusFadeState.get(el);
  if (prev) {
    clearTimeout(prev.fadeTimer);
    clearTimeout(prev.clearTimer);
    statusFadeState.delete(el);
  }

  el.style.transition = "none";
  el.classList.remove("options__status--fade", "options__status--ok", "options__status--err");
  el.textContent = message;
  if (kind === "ok") el.classList.add("options__status--ok");
  if (kind === "err") el.classList.add("options__status--err");
  void el.offsetWidth;
  el.style.transition = "";

  if (kind !== "ok" || !message) return;

  const token = {};
  const fadeTimer = setTimeout(() => {
    if (statusFadeState.get(el)?.token !== token) return;
    el.classList.add("options__status--fade");
    const clearTimer = setTimeout(() => {
      if (statusFadeState.get(el)?.token !== token) return;
      el.textContent = "";
      el.classList.remove("options__status--ok", "options__status--err", "options__status--fade");
      statusFadeState.delete(el);
    }, 1000);
    statusFadeState.set(el, { token, fadeTimer, clearTimer });
  }, 4000);
  statusFadeState.set(el, { token, fadeTimer, clearTimer: 0 });
}

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
    scheduleQueryReload();
  });

  projectInput.addEventListener("input", () => {
    invalidateWiTypesCache();
    invalidateProjectTagsCache();
    scheduleQueryReload();
  });

  // Ревью и AI заполняем сразу из storage.
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

  const aiConfig = await loadRawAiConfig();
  aiEnabledInput.checked = Boolean(aiConfig.enabled ?? DEFAULT_AI_CONFIG.enabled);
  applyAiEnabledUi(aiEnabledInput.checked);

  aiUseFixedProviderInput.checked = Boolean(aiConfig.useFixedProvider);
  aiBaseUrlInput.value = aiConfig.baseUrl ?? DEFAULT_AI_CONFIG.baseUrl;
  aiApiKeyInput.value = aiConfig.apiKey ?? DEFAULT_AI_CONFIG.apiKey;
  aiModelSelect.value = aiConfig.model ?? DEFAULT_AI_CONFIG.model;
  aiServicePromptTextarea.value = aiConfig.servicePrompt ?? DEFAULT_AI_CONFIG.servicePrompt;
  applyAiServicePromptVisibility();
  await applyAiProviderUi();

  aiUseFixedProviderInput.addEventListener("change", () => {
    void applyAiProviderUi();
  });

  aiModelRefreshButton.addEventListener("click", () => {
    void refreshAiModels({ allowPermissionRequest: true });
  });

  aiBaseUrlInput.addEventListener("change", () => {
    invalidateAiModelsCache();
    void refreshAiModels({ silent: true });
  });

  aiApiKeyInput.addEventListener("change", () => {
    invalidateAiModelsCache();
    void refreshAiModels({ silent: true });
  });

  aiEnabledInput.addEventListener("change", () => {
    void handleAiEnabledChange();
  });

  saveAiButton.addEventListener("click", () => {
    void handleAiSubmit();
  });

  aiForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleAiSubmit();
  });

  void fetchAndPopulateQueries(
    config.workItemQueryId ?? "",
    config.workItemQueryName ?? "",
  );
}

async function buildConfigForApi() {
  const stored = await loadAdoConfig();

  return {
    ...stored,
    apiRoot: apiRootInput.value.trim(),
    project: projectInput.value.trim(),
    workItemQueryId: readWorkItemQuerySelection().id,
    workItemQueryName: readWorkItemQuerySelection().name,
    refreshIntervalMinutes: getRefreshIntervalMinutesValue(),
  };
}

/**
 * Заполняет селект моделей. Текущее (сохранённое) значение сохраняется,
 * даже если его ещё нет в загруженном списке.
 * @param {string[]} models
 * @param {string} [selectedModel]
 */
function setAiModelOptions(models, selectedModel) {
  const previousValue = selectedModel ?? aiModelSelect.value;
  aiModelSelect.textContent = "";

  const ids = [...new Set(models)];
  if (previousValue && !ids.includes(previousValue)) {
    ids.unshift(previousValue);
  }

  if (ids.length === 0) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "— укажите ключ и обновите список моделей —";
    aiModelSelect.append(placeholder);
    return;
  }

  for (const id of ids) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    aiModelSelect.append(option);
  }

  aiModelSelect.value = previousValue && ids.includes(previousValue) ? previousValue : ids[0];
}

/** Сбрасывает кэш списка моделей и очищает селект. */
function invalidateAiModelsCache() {
  aiModelsCache = null;
  setAiModelOptions([]);
}

/**
 * Загружает список моделей провайдера и заполняет селект.
 * @param {{ allowPermissionRequest?: boolean, silent?: boolean }} [options]
 */
async function refreshAiModels(options = {}) {
  const { allowPermissionRequest = false, silent = false } = options;

  if (aiUseFixedProviderInput.checked) {
    return;
  }

  const baseUrl = aiBaseUrlInput.value.trim();
  const apiKey = aiApiKeyInput.value.trim();

  if (!baseUrl || !apiKey) {
    setAiModelOptions([]);
    if (!silent) {
      setOptionsStatus(saveAiStatus, "Укажите Base URL и API Key, затем обновите список моделей.", "err");
    }
    return;
  }

  if (!silent) {
    setOptionsStatus(saveAiStatus, "Загрузка списка моделей…");
  }

  try {
    const models = await fetchAiModels(baseUrl, apiKey, { allowPermissionRequest });
    aiModelsCache = models;
    setAiModelOptions(models);
    if (!silent) {
      setOptionsStatus(saveAiStatus, `Список моделей обновлён: ${models.length}`, "ok");
    }
  } catch (error) {
    console.error("[WI Notify Options] Failed to load AI models.", error);
    if (!silent) {
      setOptionsStatus(saveAiStatus, "Не удалось загрузить список моделей: " + error.message, "err");
    }
  }
}

/**
 * Синхронизирует поля Base URL и Model с тогглом «Провайдер AI»:
 * включён — поля скрыты, применяются фиксированные значения,
 * выключен — поля видимы и показывают сохранённые пользовательские значения.
 */
async function applyAiProviderUi() {
  const fixed = aiUseFixedProviderInput.checked;

  if (fixed) {
    aiBaseUrlInput.value = FIXED_AI_BASE_URL;
    setAiModelOptions([FIXED_AI_MODEL], FIXED_AI_MODEL);
  } else {
    const stored = await loadRawAiConfig();
    aiBaseUrlInput.value = stored.baseUrl ?? "";
    setAiModelOptions(aiModelsCache ?? [], stored.model ?? "");
    void refreshAiModels({ silent: true });
  }

  aiBaseUrlInput.required = !fixed;
  aiModelSelect.required = !fixed;
  aiBaseUrlInput.closest(".options__field")?.toggleAttribute("hidden", fixed);
  aiModelSelect.closest(".options__field")?.toggleAttribute("hidden", fixed);
}

/**
 * Скрывает поле промпта, не очищая его: значение остаётся в форме и сохраняется.
 */
function applyAiServicePromptVisibility() {
  const field = aiServicePromptTextarea.closest(".options__field");
  const visible = SHOW_AI_SERVICE_PROMPT;
  field?.toggleAttribute("hidden", !visible);
  aiServicePromptTextarea.required = visible;
}

async function buildAiConfigForSave() {
  const stored = await loadRawAiConfig();

  return applyFixedAiProvider({
    ...stored,
    useFixedProvider: aiUseFixedProviderInput.checked,
    baseUrl: aiBaseUrlInput.value.trim(),
    apiKey: aiApiKeyInput.value.trim(),
    model: aiModelSelect.value.trim(),
    servicePrompt: aiServicePromptTextarea.value.trim(),
  });
}

async function handleSubmit() {
  if (saveButton.disabled) {
    return;
  }

  saveButton.disabled = true;
  setOptionsStatus(saveStatus, "");

  try {
    const stored = await loadAdoConfig();
    const merged = {
      ...stored,
      apiRoot: apiRootInput.value.trim(),
      project: projectInput.value.trim(),
      workItemQueryId: readWorkItemQuerySelection().id,
      workItemQueryName: readWorkItemQuerySelection().name,
      refreshIntervalMinutes: getRefreshIntervalMinutesValue(),
    };

    const errors = validateAdoConfig(merged);

    if (errors.length > 0) {
      setOptionsStatus(saveStatus, errors.join(" "), "err");
      return;
    }

    try {
      await chrome.storage.local.set({
        [ADO_CONFIG_KEY]: merged,
      });
      console.log('Config saved successfully:', merged);
    } catch (error) {
      console.error('Failed to save config:', error);
      setOptionsStatus(saveStatus, "Ошибка сохранения: " + error.message, "err");
      return;
    }

    await requestDevAzureHostPermissionIfNeeded(merged.apiRoot);

    // Reload the config to verify it's saved and update form values
    const savedConfig = await loadAdoConfig();
    console.log('Loaded config after save:', savedConfig);
    apiRootInput.value = savedConfig.apiRoot;
    projectInput.value = savedConfig.project;
    refreshIntervalMinutesInput.value = String(savedConfig.refreshIntervalMinutes);
    await fetchAndPopulateQueries(
      savedConfig.workItemQueryId ?? "",
      savedConfig.workItemQueryName ?? "",
      { preserveSelection: true },
    );
    console.log('Form values set to:', apiRootInput.value, projectInput.value, workItemQuerySelect?.value);

    await refreshCustomButtonTypeFields();

    setOptionsStatus(saveStatus, "Благополучно сохранено", "ok");
  } finally {
    saveButton.disabled = false;
  }
}

async function handleReviewSubmit() {
  setOptionsStatus(saveReviewStatus, "");

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
    setOptionsStatus(saveReviewStatus, errors.join(" "), "err");
    return;
  }

  try {
    await chrome.storage.local.set({
      [ADO_CONFIG_KEY]: merged,
    });
  } catch (error) {
    setOptionsStatus(saveReviewStatus, "Ошибка сохранения: " + error.message, "err");
    return;
  }

  setOptionsStatus(saveReviewStatus, "Благополучно сохранено", "ok");
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
  setOptionsStatus(saveReviewStatus, "");

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
    setOptionsStatus(saveReviewStatus, "Ошибка сохранения: " + error.message, "err");
  }
}

// --- AI -----------------------------------------------------------

/**
 * Сворачивает/разворачивает поля блока «AI Rewrite» по состоянию тоггла.
 * @param {boolean} enabled
 */
function applyAiEnabledUi(enabled) {
  aiFieldset.classList.toggle("options__fieldset--collapsed", !enabled);
  aiOptionsBody.hidden = !enabled;
  aiEnabledInput.setAttribute("aria-checked", enabled ? "true" : "false");
}

/**
 * Тоггл сразу пишется в storage — иначе при выключении нельзя сохранить через скрытую кнопку.
 */
async function handleAiEnabledChange() {
  const enabled = aiEnabledInput.checked;
  applyAiEnabledUi(enabled);
  setOptionsStatus(saveAiStatus, "");

  try {
    const stored = await loadRawAiConfig();
    await chrome.storage.local.set({
      [AI_CONFIG_KEY]: {
        ...stored,
        enabled,
      },
    });
  } catch (error) {
    aiEnabledInput.checked = !enabled;
    applyAiEnabledUi(aiEnabledInput.checked);
    setOptionsStatus(saveAiStatus, "Ошибка сохранения: " + error.message, "err");
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
  setOptionsStatus(saveAiStatus, "");

  const merged = await buildAiConfigForSave();
  const errors = validateAiConfig(merged);

  if (errors.length > 0) {
    setOptionsStatus(saveAiStatus, errors.join(" "), "err");
    return;
  }

  try {
    await chrome.storage.local.set({
      [AI_CONFIG_KEY]: merged,
    });
    console.log('AI Config saved successfully:', merged);
  } catch (error) {
    console.error('Failed to save AI config:', error);
    setOptionsStatus(saveAiStatus, "Ошибка сохранения настроек: " + error.message, "err");
    return;
  }

  // Request host permission for the AI API base URL if not already granted
  try {
    await requestAiHostPermissionIfNeeded(merged.baseUrl);
  } catch (error) {
    console.error('AI host permission request failed:', error);
    setOptionsStatus(
      saveAiStatus,
      error instanceof Error ? error.message : String(error),
      "err",
    );
    return;
  }

  setOptionsStatus(saveAiStatus, "Благополучно сохранено", "ok");
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

function scheduleQueryReload() {
  clearTimeout(queryReloadTimer);
  queryReloadTimer = setTimeout(() => {
    void fetchAndPopulateQueries();
  }, 400);
}

function readSelectedQueryName() {
  const id = workItemQuerySelect?.value.trim() ?? "";
  if (!id) {
    return "";
  }

  const option = workItemQuerySelect?.selectedOptions?.[0];
  return String(option?.dataset.name || option?.textContent || "").trim();
}

function readWorkItemQuerySelection() {
  if (querySelectionPending) {
    return {
      id: String(querySelectionPending.id ?? "").trim(),
      name: String(querySelectionPending.name ?? "").trim(),
    };
  }

  const id = workItemQuerySelect?.value.trim() ?? "";
  return {
    id,
    name: id ? readSelectedQueryName() : "",
  };
}

function showQueryLoading() {
  if (!workItemQuerySelect) {
    return;
  }

  workItemQuerySelect.disabled = true;
  workItemQuerySelect.innerHTML = "";
  const loading = document.createElement("option");
  loading.value = "";
  loading.textContent = "Loading";
  loading.selected = true;
  workItemQuerySelect.appendChild(loading);
}

/**
 * @param {string} [preferredId]
 * @param {string} [preferredName]
 * @param {{ preserveSelection?: boolean }} [options]
 */
async function fetchAndPopulateQueries(preferredId, preferredName, options = {}) {
  if (!workItemQuerySelect) {
    return;
  }

  const preserveSelection = Boolean(options.preserveSelection);
  const apiRoot = apiRootInput.value.trim();
  const project = projectInput.value.trim();
  const pendingSelection = querySelectionPending;
  const previousId = typeof preferredId === "string"
    ? preferredId.trim()
    : (pendingSelection?.id || workItemQuerySelect.value).trim();
  const previousName = typeof preferredName === "string"
    ? preferredName.trim()
    : (pendingSelection?.name || readSelectedQueryName());
  const projectChanged = Boolean(queriesLoadedForProject)
    && queriesLoadedForProject !== project;
  const token = ++queryFetchToken;

  if (!apiRoot || !project) {
    querySelectionPending = null;
    resetWorkItemQuerySelect();
    workItemQuerySelect.disabled = false;
    if (workItemQueryHint) {
      workItemQueryHint.textContent = WORK_ITEM_QUERY_HINT;
    }
    return;
  }

  if (!preserveSelection) {
    querySelectionPending = !projectChanged && previousId
      ? { id: previousId, name: previousName }
      : null;
    showQueryLoading();
  } else {
    workItemQuerySelect.disabled = false;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: LIST_QUERIES_MESSAGE_TYPE,
      apiRoot,
      project,
    });

    if (token !== queryFetchToken) {
      return;
    }

    if (!response?.ok) {
      throw new Error(response?.error || "Не удалось загрузить список Query.");
    }

    const queries = Array.isArray(response.queries) ? response.queries : [];
    const groups = new Map();

    for (const query of queries) {
      const id = String(query?.id ?? "").trim();
      const name = String(query?.name ?? "").trim();
      if (!id || !name) {
        continue;
      }

      const { root, label } = splitQueryPath(query?.path, name);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root).push({ id, name, label });
    }

    resetWorkItemQuerySelect();

    for (const [root, items] of groups) {
      const group = document.createElement("optgroup");
      group.label = root;
      for (const item of items) {
        group.appendChild(createQueryOption(item.id, item.label, item.name));
      }
      workItemQuerySelect.appendChild(group);
    }

    const known = queries.some((query) => String(query?.id ?? "").trim() === previousId);
    if (previousId && !known && !projectChanged) {
      workItemQuerySelect.appendChild(
        createQueryOption(previousId, previousName || previousId, previousName || previousId),
      );
    }

    workItemQuerySelect.value = previousId && (known || !projectChanged) ? previousId : "";
    querySelectionPending = null;
    queriesLoadedForProject = project;
    if (workItemQueryHint) {
      workItemQueryHint.textContent = WORK_ITEM_QUERY_HINT;
    }
  } catch (error) {
    if (token !== queryFetchToken) {
      return;
    }

    console.error("Failed to fetch queries:", error);
    if (!preserveSelection) {
      resetWorkItemQuerySelect();
      if (previousId && !projectChanged) {
        workItemQuerySelect.appendChild(
          createQueryOption(previousId, previousName || previousId, previousName || previousId),
        );
        workItemQuerySelect.value = previousId;
      }
    }
    querySelectionPending = null;
    if (workItemQueryHint) {
      const detail = error instanceof Error ? error.message : String(error);
      workItemQueryHint.textContent = `Не удалось загрузить список Query. ${detail}`;
    }
  } finally {
    if (token === queryFetchToken) {
      workItemQuerySelect.disabled = false;
    }
  }
}

function resetWorkItemQuerySelect() {
  workItemQuerySelect.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "Все мои задачи";
  workItemQuerySelect.appendChild(empty);
}

function createQueryOption(id, label, name) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = label;
  option.dataset.name = name;
  return option;
}

function splitQueryPath(path, name) {
  const parts = String(path || name)
    .split(/[\\/]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const leaf = parts.length ? parts[parts.length - 1] : name;
  const root = parts.length > 1 ? parts[0] : "Queries";
  const middle = parts.slice(1, -1);
  const label = middle.length ? `${middle.join(" / ")} / ${leaf}` : leaf;
  return { root, label };
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
    titlePrefix: val('[data-field="titlePrefix"]').value.trim(),
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
  const box = card.querySelector("[data-tags]");
  if (box && input) {
    box.addEventListener("click", (e) => {
      if (e.target === box || e.target.closest("[data-tags-chips]")) input.focus();
    });
  }

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
  const box = card.querySelector("[data-types]");
  if (box) {
    box.addEventListener("click", (e) => {
      if (e.target === box || e.target.closest("[data-types-chips]")) input.focus();
    });
  }

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
  card.querySelector('[data-field="titlePrefix"]').value = config?.titlePrefix ?? "";
  card.querySelector('[data-field="description"]').value = config?.description ?? "";

  const titleInput = card.querySelector('[data-field="title"]');
  const titlePrefixInput = card.querySelector('[data-field="titlePrefix"]');
  const fromParent = card.querySelector('[data-field="titleFromParent"]');
  fromParent.checked = Boolean(config?.titleFromParent);
  const syncTitleDisabled = () => {
    titleInput.disabled = fromParent.checked;
    titlePrefixInput.hidden = !fromParent.checked;
    if (!fromParent.checked) titlePrefixInput.value = "";
  };
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

  card.querySelector("[data-add-link]").addEventListener("click", (e) => {
    e.preventDefault();
    addLinkCard(card);
  });

  card.querySelector("[data-save]").addEventListener("click", async () => {
    const status = card.querySelector("[data-status]");
    const cfg = readCardConfig(card);
    if (!cfg.name) {
      setOptionsStatus(status, "Укажите название кнопки", "err");
      return;
    }
    if (!cfg.wiType) {
      setOptionsStatus(status, "Выберите тип Wi", "err");
      return;
    }
    if (!cfg.titleFromParent && !cfg.title) {
      setOptionsStatus(status, "Укажите название задачи или включите «из исходной задачи»", "err");
      return;
    }

    try {
      const stored = await loadAdoConfig();
      const buttons = Array.isArray(stored.customReviewButtons) ? [...stored.customReviewButtons] : [];
      const idx = buttons.findIndex((b) => b.id === cfg.id);
      if (idx >= 0) buttons[idx] = cfg; else buttons.push(cfg);
      await saveCustomButtons(buttons);
      setOptionsStatus(status, "Благополучно сохранено", "ok");
    } catch (error) {
      setOptionsStatus(
        status,
        "Ошибка сохранения: " + (error instanceof Error ? error.message : String(error)),
        "err",
      );
    }
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

// --- Переключение вкладок -----------------------------

const tabs = document.querySelectorAll(".options__tab");
const panels = document.querySelectorAll(".options__panel");

function showPanelByTab(tabName) {
  tabs.forEach((t) => {
    t.setAttribute("aria-selected", "false");
    t.setAttribute("tabindex", "-1");
  });

  const activeTab = document.querySelector(`.options__tab[data-tab="${tabName}"]`);
  if (activeTab) {
    activeTab.setAttribute("aria-selected", "true");
    activeTab.setAttribute("tabindex", "0");
  }

  panels.forEach((panel) => {
    panel.hidden = true;
  });

  const activePanel = document.getElementById(`panel-${tabName}`);
  if (activePanel) {
    activePanel.hidden = false;
  }
}

// Инициализация при загрузке — показать первую вкладку
showPanelByTab("basic");

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const tabName = tab.dataset.tab;
    showPanelByTab(tabName);
  });

  // Поддержка клавиатуры: Tab для навигации между вкладками
  tab.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      tab.click();
    }
  });
});

