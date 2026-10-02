import { loadAiConfig } from "./ai-config.mjs";

const AI_REQUEST_TIMEOUT_MS = 90000;
const RUNTIME_SERVICE_PROMPT_SUFFIX = [
  "Верни только финальный текст",
  "Не используй markdown-таблицы, ASCII-таблицы и HTML-таблицы.",
  "Если нужно сравнение или структура, используй списки и обычные абзацы.",
].join(" ");

function buildOriginPattern(baseUrl) {
  const parsedUrl = new URL(baseUrl);
  return `${parsedUrl.protocol}//${parsedUrl.host}/*`;
}

function buildChatCompletionsUrl(baseUrl) {
  const normalizedBaseUrl = String(baseUrl ?? "").replace(/\/+$/, "");
  return `${normalizedBaseUrl}/chat/completions`;
}

/**
 * Превращает тело ошибки провайдера в короткое сообщение.
 * Страницу блокировки Cloudflare не показывает целиком.
 * @param {number} status
 * @param {string} body
 */
function formatAiProviderError(status, body) {
  const text = String(body ?? "").trim();
  const isHtml = /<!DOCTYPE html|<html[\s>]|Attention Required! \| Cloudflare/i.test(text);

  if (isHtml && /cloudflare|sorry, you have been blocked|cf-error-details/i.test(text)) {
    const rayId = text.match(/Cloudflare Ray ID:\s*(?:<strong[^>]*>)?([A-Za-z0-9]+)/i)?.[1];
    const blockedHost = text.match(/unable to access<\/span>\s*([^<]+)/i)?.[1]?.trim();
    const hostPart = blockedHost ? ` (${blockedHost})` : "";
    const rayPart = rayId ? ` Ray ID: ${rayId}.` : "";
    return `Cloudflare заблокировал запрос к провайдеру${hostPart}: HTTP ${status}.${rayPart} Это ограничение WAF или сети, а не ошибка API-ключа.`;
  }

  if (isHtml) {
    return `Провайдер вернул HTML вместо ответа API (HTTP ${status}).`;
  }

  const compact = text.replace(/\s+/g, " ").slice(0, 300);
  return compact ? `AI API error: ${status} - ${compact}` : `AI API error: ${status}`;
}

async function ensureAiHostPermission(baseUrl) {
  const origins = [buildOriginPattern(baseUrl)];
  const hasPermission = await chrome.permissions.contains({ origins });
  console.log("[WI Notify AI] AI host permission check.", { origins, hasPermission });

  if (hasPermission) {
    return origins[0];
  }

  throw new Error(
    `AI host permission is missing for ${origins[0]}. Open extension options, click "Сохранить AI настройки" and allow access.`
  );
}

/**
 * Загружает список моделей OpenAI-совместимого провайдера (GET {baseUrl}/models).
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {{ allowPermissionRequest?: boolean }} [options]
 * @returns {Promise<string[]>} Список идентификаторов моделей.
 */
export async function fetchAiModels(baseUrl, apiKey, options = {}) {
  const { allowPermissionRequest = false } = options;

  if (!baseUrl) {
    throw new Error("AI Base URL is not configured.");
  }
  if (!apiKey) {
    throw new Error("AI API Key is not configured.");
  }

  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, "");
  const origins = [buildOriginPattern(baseUrl)];
  let hasPermission = await chrome.permissions.contains({ origins });

  if (!hasPermission && allowPermissionRequest) {
    hasPermission = await chrome.permissions.request({ origins });
    console.log("[WI Notify AI] AI host permission requested.", { origins, hasPermission });
  }

  if (!hasPermission) {
    throw new Error(
      `AI host permission is missing for ${origins[0]}. Нажмите «Обновить» ещё раз и разрешите доступ к серверу провайдера.`
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`AI models request timed out after ${AI_REQUEST_TIMEOUT_MS}ms.`));
  }, AI_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${normalizedBaseUrl}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = response.statusText;

      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData.error?.message || errorMessage;
      } catch (parseError) {
        if (!(parseError instanceof SyntaxError)) {
          throw parseError;
        }
        throw new Error(formatAiProviderError(response.status, errorText || errorMessage));
      }

      throw new Error(`AI API error: ${response.status} - ${errorMessage}`);
    }

    const data = await response.json();
    const models = Array.isArray(data?.data)
      ? data.data.map((item) => String(item?.id ?? "")).filter(Boolean).sort((a, b) => a.localeCompare(b))
      : [];

    console.log("[WI Notify AI] AI models fetched.", { baseUrl: normalizedBaseUrl, count: models.length });
    return models;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`AI models request timed out after ${AI_REQUEST_TIMEOUT_MS}ms.`);
    }

    console.error("[WI Notify AI] Error fetching AI models:", error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function chatCompletion(userMessage) {
  const config = await loadAiConfig();
  console.log("[WI Notify AI] AI config loaded for chatCompletion.", {
    baseUrl: config.baseUrl,
    model: config.model,
    hasApiKey: Boolean(config.apiKey),
    hasServicePrompt: Boolean(config.servicePrompt),
    userMessageLength: userMessage.length,
  });

  if (!config.apiKey) {
    throw new Error("AI API Key is not configured.");
  }
  if (!config.baseUrl) {
    throw new Error("AI Base URL is not configured.");
  }
  if (!config.model) {
    throw new Error("AI Model is not configured.");
  }
  if (!config.servicePrompt) {
    throw new Error("AI Service Prompt is not configured.");
  }

  const allowedOrigin = await ensureAiHostPermission(config.baseUrl);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };

  const body = JSON.stringify({
    model: config.model,
    messages: [
      { role: "system", content: `${config.servicePrompt}\n\n${RUNTIME_SERVICE_PROMPT_SUFFIX}` },
      { role: "user", content: userMessage },
    ],
    // Add other parameters as needed, e.g., temperature, max_tokens
  });
  const requestUrl = buildChatCompletionsUrl(config.baseUrl);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`AI request timed out after ${AI_REQUEST_TIMEOUT_MS}ms.`));
    }, AI_REQUEST_TIMEOUT_MS);

    console.log("[WI Notify AI] Sending AI request.", {
      url: requestUrl,
      allowedOrigin,
      bodyLength: body.length,
      timeoutMs: AI_REQUEST_TIMEOUT_MS,
    });
    let response;
    try {
      response = await fetch(requestUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    console.log("[WI Notify AI] AI response received.", {
      status: response.status,
      ok: response.ok,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = response.statusText;

      try {
        const errorData = JSON.parse(errorText);
        console.error("[WI Notify AI] AI request failed.", errorData);
        errorMessage = errorData.error?.message || errorMessage;
      } catch (parseError) {
        if (!(parseError instanceof SyntaxError)) {
          throw parseError;
        }
        console.error("[WI Notify AI] AI request failed with non-JSON body.", errorText.slice(0, 500));
        throw new Error(formatAiProviderError(response.status, errorText || errorMessage));
      }

      throw new Error(`AI API error: ${response.status} - ${errorMessage}`);
    }

    const data = await response.json();
    console.log("[WI Notify AI] AI response parsed.", {
      choices: Array.isArray(data.choices) ? data.choices.length : 0,
      contentLength: data.choices[0]?.message?.content?.length ?? 0,
    });
    return data.choices[0]?.message?.content || "";
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error("[WI Notify AI] AI request aborted by timeout.", error);
      throw new Error(`AI request timed out after ${AI_REQUEST_TIMEOUT_MS}ms.`);
    }

    console.error("[WI Notify AI] Error calling AI API:", error);
    throw error;
  }
}
