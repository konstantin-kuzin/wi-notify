export const AI_CONFIG_KEY = "aiConfig";

/** Базовые настройки подключения к OpenAI-совместимому API. */
export const DEFAULT_AI_CONFIG = {
  baseUrl: "https://llm.kaspersky-labs.com/v1",
  apiKey: "",
  model: "gpt-4o",
  servicePrompt: "Перепиши описание задачи, сделав его более структурированным и понятным, сохранив технические детали. Не используй таблицы в любом виде; оформляй информацию списками и обычными абзацами.",
};

export async function loadAiConfig() {
  const stored = await chrome.storage.local.get(AI_CONFIG_KEY);
  const partial = stored[AI_CONFIG_KEY] ?? {};
  return { ...DEFAULT_AI_CONFIG, ...partial };
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
