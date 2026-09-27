export const AI_CONFIG_KEY = "aiConfig";

/**
 * Скрывает поля AI Base URL и AI Model в настройках.
 * При true подставляются фиксированные значения ниже.
 */
export const HIDE_AI_CONNECTION_FIELDS = true;

export const FIXED_AI_BASE_URL = "https://llm.kaspersky-labs.com/v1/";
export const FIXED_AI_MODEL = "best-for-chat";

/** Базовые настройки подключения к OpenAI-совместимому API. */
export const DEFAULT_AI_CONFIG = {
  baseUrl: FIXED_AI_BASE_URL,
  apiKey: "",
  model: FIXED_AI_MODEL,
  servicePrompt: "Перепиши описание задачи, сделав его более структурированным и понятным, сохранив технические детали. Не используй таблицы в любом виде; оформляй информацию списками и обычными абзацами.",
};

/**
 * @param {Record<string, unknown>} config
 */
export function applyHiddenAiFields(config) {
  if (!HIDE_AI_CONNECTION_FIELDS) {
    return config;
  }

  return {
    ...config,
    baseUrl: FIXED_AI_BASE_URL,
    model: FIXED_AI_MODEL,
  };
}

export async function loadAiConfig() {
  const stored = await chrome.storage.local.get(AI_CONFIG_KEY);
  const partial = stored[AI_CONFIG_KEY] ?? {};
  return applyHiddenAiFields({ ...DEFAULT_AI_CONFIG, ...partial });
}

export function validateAiConfig(config) {
  const errors = [];

  if (!config.baseUrl?.trim()) {
    errors.push("Укажите базовый URL AI-провайдера.");
  }
  try {
    new URL(config.baseUrl);
  } catch (_) {
    errors.push("Базовый URL AI-провайдера не является валидным URL.");
  }

  if (!config.apiKey?.trim()) {
    errors.push("Укажите API Key для AI-провайдера.");
  }

  if (!config.model?.trim()) {
    errors.push("Укажите модель AI.");
  }

  if (!config.servicePrompt?.trim()) {
    errors.push("Укажите системный промпт для AI.");
  }

  return errors;
}
