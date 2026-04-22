export const ADO_CONFIG_KEY = "adoConfig";

/** Базовые настройки подключения к Azure DevOps. */
export const DEFAULT_ADO_CONFIG = {
  apiRoot: "https://hqrndtfs.avp.ru/tfs/DefaultCollection",
  project: "Monorepo",
  iterationPath: "",
  /**
   * Версия REST API (`api-version` в запросах). На странице настроек не показывается —
   * меняйте здесь (или вручную в `chrome.storage.local` → `adoConfig`), если серверу нужна
   * другая версия (например `7.1` для dev.azure.com).
   */
   apiVersion: "6.0-preview",
  /**
   * `session` — куки браузера; `pat` — токен из поля `pat` ниже (без UI PAT можно задать в storage).
   * На странице настроек не показывается.
   */
  authMode: "session",
  pat: "",
};

export async function loadAdoConfig() {
  const stored = await chrome.storage.local.get(ADO_CONFIG_KEY);
  console.log('Storage get result:', stored);
  const partial = stored[ADO_CONFIG_KEY] ?? {};
  console.log('Partial config:', partial);
  const raw = { ...DEFAULT_ADO_CONFIG, ...partial };
  raw.apiVersion = '6.0-preview';

  // Remove deprecated fields
  delete raw.repositoryId;
  delete raw.selectedGroupIds;
  delete raw.selectedGroupLabels;

  // Save back to storage to persist the corrected config
  await chrome.storage.local.set({ [ADO_CONFIG_KEY]: raw });

  console.log('Raw config after merge:', raw);

  return raw;
}



export function validateAdoConfig(config) {
  const errors = [];

  if (!config.apiRoot?.trim()) {
    errors.push("Укажите корень API (URL коллекции, например …/tfs/DefaultCollection).");
  }

  if (!config.project?.trim()) {
    errors.push("Укажите проект.");
  }

  const ver = resolveApiVersion(config);

  return errors;
}

export function resolveApiVersion(config) {
  const raw = config?.apiVersion ?? DEFAULT_ADO_CONFIG.apiVersion;
  return String(raw ?? "").trim() || DEFAULT_ADO_CONFIG.apiVersion;
}

function isPlausibleApiVersion(ver) {
  if (!ver || /[\s<>'"]/.test(ver)) {
    return false;
  }

  return /^\d+\.\d+([\w.-]+)?$/.test(ver);
}

export function normalizeApiRoot(apiRoot) {
  return String(apiRoot ?? "").replace(/\/+$/, "");
}
