export const AI_CONFIG_KEY = "aiConfig";

/** Фиксированные настройки встроенного провайдера AI.AVP.RU. */
export const FIXED_AI_BASE_URL = "https://llm.kaspersky-labs.com/v1/";
export const FIXED_AI_MODEL = "best-for-chat";

/** Базовые настройки подключения к OpenAI-совместимому API. */
export const DEFAULT_AI_CONFIG = {
  enabled: true,
  useFixedProvider: true,
  baseUrl: FIXED_AI_BASE_URL,
  apiKey: "",
  model: FIXED_AI_MODEL,
  servicePrompt: `Роль: Ты — профессиональный эксперт по деловой переписке, превосходно владеющий русским языком 
Задача: 
Переписать исходный рабочий текст в вежливое, лаконичное и структурированное сообщение для корпоративного чата 

Инструкции по редактированию:
1. Используй современный деловой инфостиль. Текст должен быть уважительным, но без канцелярита и излишнего пафоса. Исключи сленг, разговорные маркеры и эмоциональные повторы.
2. Если в тексте есть обращение к человеку, то заменяй краткие имена на полные официальные формы (например: Паша -> Павел, Наташа -> Наталья). К адресату всегда обращайся на «ты», но сохраняй профессиональную дистанцию.
3. Разделяй текст на короткие абзацы. Используй списки для задач. Пиши кратко, убирай «воду» и длинные вступления. 
4. Строго сохраняй исходный смысл, договоренности, сроки и суть поручений. Не добавляй факты, которых не было в исходном тексте. 
5. Если не знаешь названия задачи или имени адресата — не придумывай его.
6. Строго следи за датами, учитывай текущую дату. Если нужно указать дату напиши и дату и день недели.

Правила вывода ответа:
Выдай в ответе ТОЛЬКО финальный, готовый к отправке текст сообщения. Любые вводные фразы, приветствия от нейросети, пояснения или комментарии к правкам строго запрещены.`,
};

/**
 * Подменяет URL и модель фиксированными значениями, когда включён
 * встроенный провайдер. При выключенном тоггле настройки не трогает.
 * @param {Record<string, unknown>} config
 */
export function applyFixedAiProvider(config) {
  if (!config.useFixedProvider) {
    return config;
  }

  return {
    ...config,
    baseUrl: FIXED_AI_BASE_URL,
    model: FIXED_AI_MODEL,
  };
}

/** Настройки «как сохранены» — для формы настроек. */
export async function loadRawAiConfig() {
  const stored = await chrome.storage.local.get(AI_CONFIG_KEY);
  const partial = stored[AI_CONFIG_KEY] ?? {};
  return { ...DEFAULT_AI_CONFIG, ...partial };
}

/** Эффективные настройки для рантайма (с учётом фиксированного провайдера). */
export async function loadAiConfig() {
  return applyFixedAiProvider(await loadRawAiConfig());
}

export function validateAiConfig(config) {
  const errors = [];

  if (!config.useFixedProvider) {
    if (!config.baseUrl?.trim()) {
      errors.push("Укажите базовый URL AI-провайдера.");
    }
    try {
      new URL(config.baseUrl);
    } catch (_) {
      errors.push("Базовый URL AI-провайдера не является валидным URL.");
    }

    if (!config.model?.trim()) {
      errors.push("Укажите модель AI.");
    }
  }

  if (!config.apiKey?.trim()) {
    errors.push("Укажите API Key для AI-провайдера.");
  }

  if (!config.servicePrompt?.trim()) {
    errors.push("Укажите системный промпт для AI.");
  }

  return errors;
}
