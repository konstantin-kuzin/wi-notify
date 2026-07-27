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
    void fetchAndPopulateIterations();
  });

  projectInput.addEventListener("input", () => {
    void fetchAndPopulateIterations();
  });

  await fetchAndPopulateIterations(config.iterationPath ?? "");

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
