import {
  ADO_CONFIG_KEY,
  DEFAULT_ADO_CONFIG,
  loadAdoConfig,
  validateAdoConfig,
} from "./ado-config.mjs";
const form = document.querySelector("#options-form");
const apiRootInput = document.querySelector("#api-root");
const projectInput = document.querySelector("#project");
const iterationPathSelect = document.querySelector("#iteration-path");
const saveButton = document.querySelector("#save-button");
const saveStatus = document.querySelector("#save-status");

void init();

async function init() {
  const config = await loadAdoConfig();
  apiRootInput.value = config.apiRoot ?? DEFAULT_ADO_CONFIG.apiRoot;
  projectInput.value = config.project ?? DEFAULT_ADO_CONFIG.project;

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
}

async function buildConfigForApi() {
  const stored = await loadAdoConfig();

  return {
    ...stored,
    apiRoot: apiRootInput.value.trim(),
    project: projectInput.value.trim(),
    iterationPath: iterationPathSelect.value.trim(),
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
  await fetchAndPopulateIterations(savedConfig.iterationPath ?? "");
  console.log('Form values set to:', apiRootInput.value, projectInput.value, iterationPathSelect.value);

  saveStatus.textContent = "Сохранено. Список work items обновится автоматически.";
  saveStatus.classList.add("options__status--ok");
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
