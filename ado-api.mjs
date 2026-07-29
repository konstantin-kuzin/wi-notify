import {
  normalizeApiRoot,
  parseReviewParentId,
  parseWorkItemId,
  resolveApiVersion,
  resolveReviewProject,
} from "./ado-config.mjs";
import { buildCustomWorkItemFields } from "./custom-wi-fields.mjs";

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 900;
const WORK_ITEMS_BATCH_SIZE = 200;
const TYPE_STATES_CACHE_TTL_MS = 5 * 60 * 1000;
const typeStatesCache = new Map();
const workItemTypeIconCache = new Map();
const workItemIconsCatalogCache = new Map();
const projectProcessIdCache = new Map();
const projectGuidCache = new Map();

/**
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 */
function buildAuthHeaders(config) {
  const headers = {
    Accept: "application/json",
  };

  if (config.authMode === "pat" && config.pat?.trim()) {
    const basic = btoa(`:${config.pat.trim()}`);
    headers.Authorization = `Basic ${basic}`;
  }

  return headers;
}

/**
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {string} pathAndQuery
 */
export async function adoFetch(config, pathAndQuery, init = {}) {
  const root = normalizeApiRoot(config.apiRoot);
  const url = `${root}/${pathAndQuery.replace(/^\//, "")}`;
  const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(
    (init.method ?? "GET").toUpperCase(),
  );

  const headers = {
    ...buildAuthHeaders(config),
    ...(init.headers ?? {}),
  };

  if (isWrite && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let response;

    try {
      response = await fetch(url, {
        ...init,
        headers,
        credentials: config.authMode === "session" ? "include" : "omit",
        cache: "no-store",
      });
    } catch (error) {
      lastError = error instanceof Error
        ? error
        : new Error(String(error ?? "Запрос к Azure DevOps не выполнен."));

      if (attempt < MAX_RETRIES) {
        await delay(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }

      throw lastError;
    }

    if (response.status === 429 && attempt < MAX_RETRIES) {
      await delay(RETRY_BASE_MS * 2 ** attempt);
      continue;
    }

    if (!response.ok) {
      lastError = await buildAdoHttpError(response);
      break;
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();

    if (!text) {
      return null;
    }

    try {
      const data = JSON.parse(text);
      console.log("[ado API]", (init.method ?? "GET").toUpperCase(), url, data);
      return data;
    } catch (_error) {
      lastError = new Error("Ответ API не является JSON.");
      break;
    }
  }

  throw lastError ?? new Error("Запрос к Azure DevOps не выполнен.");
}

function extractAdoErrorDetail(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return "";
  }

  const direct =
    (typeof parsed.message === "string" && parsed.message) ||
    (typeof parsed.Message === "string" && parsed.Message) ||
    "";

  if (direct.trim()) {
    return direct.trim();
  }

  const nested = parsed.error;
  if (nested && typeof nested === "object") {
    const msg =
      (typeof nested.message === "string" && nested.message) ||
      (typeof nested.Message === "string" && nested.Message) ||
      "";
    if (msg.trim()) {
      return msg.trim();
    }
  }

  return "";
}

async function buildAdoHttpError(response) {
  let detail = "";

  try {
    const text = await response.text();

    if (text) {
      const parsed = JSON.parse(text);
      detail = extractAdoErrorDetail(parsed);
    }
  } catch (_error) {
    // ignore
  }

  const status = response.status;
  let base = mapStatusToMessage(status);

  if (status === 400 && detail) {
    if (/preview flag must be supplied|-preview/i.test(detail)) {
      base = "Для этой версии API сервер требует суффикс -preview (например 6.0-preview). Укажите это в настройках расширения.";
    } else if (/out of range|REST API version|api version/i.test(detail)) {
      base = "Версия REST API не подходит серверу. В настройках укажите поддерживаемый api-version.";
    }
  }

  if (detail && !looksSensitive(detail)) {
    return new Error(`${base} ${detail}`.trim());
  }

  return new Error(base);
}

function looksSensitive(text) {
  return /pat|password|token|authorization|bearer/i.test(text);
}

function mapStatusToMessage(status) {
  if (status === 401) {
    return "Доступ запрещён (401): войдите в Azure DevOps в браузере или укажите PAT в настройках.";
  }

  if (status === 403) {
    return "Недостаточно прав (403): проверьте права на Azure DevOps или PAT.";
  }

  if (status === 404) {
    return "Ресурс не найден (404): проверьте project и корень API.";
  }

  if (status === 429) {
    return "Слишком много запросов (429): повторите позже.";
  }

  if (status >= 500) {
    return `Ошибка сервера Azure DevOps (${status}).`;
  }

  return `Ошибка HTTP ${status}.`;
}

/** Путь из classification nodes содержит сегмент «Iteration»; в System.IterationPath его обычно нет. */
function wiqlPathWithoutClassificationIteration(rawPath) {
  let p = rawPath.trim().replace(/^\\+/, "");
  while (/\\Iteration\\/i.test(p)) {
    p = p.replace(/\\Iteration\\/i, "\\");
  }
  return p.replace(/\\Iteration$/i, "");
}

/**
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 */
export async function fetchConnectionIdentity(config) {
  const query = new URLSearchParams({
    connectOptions: "1",
    lastChangeId: "-1",
    lastChangeId64: "-1",
    "api-version": resolveApiVersion(config),
  });

  const data = await adoFetch(config, `_apis/connectionData?${query.toString()}`);
  const id = data?.authenticatedUser?.id;

  if (!id) {
    throw new Error("Не удалось определить текущего пользователя (connectionData).");
  }

  return {
    id: String(id),
    displayName: data?.authenticatedUser?.displayName ?? "",
    uniqueName: data?.authenticatedUser?.uniqueName ?? "",
  };
}

/**
 * Собирает unique name, который ADO принимает в System.AssignedTo.
 * Нельзя подставлять голый samAccountName в «Имя <alias>» — сервер вернёт 400.
 *
 * На on-prem TFS email часто «unknown identity»; приоритет:
 * DOMAIN\alias → email → пусто (тогда оставляем только displayName).
 * @param {Record<string, unknown>} item
 * @returns {string}
 */
function resolveIdentityUniqueName(item) {
  const sam = normalizeText(
    item?.samAccountName || item?.accountName || item?.account,
  );
  const domain = normalizeText(item?.domain || item?.scopeName);

  // On-prem Windows identity: DOMAIN\alias
  if (sam && domain && !domain.includes("\\") && !domain.includes("@")) {
    return `${domain}\\${sam}`;
  }

  // Уже готовый unique name вида DOMAIN\alias
  if (sam.includes("\\")) {
    return sam;
  }

  const mail = normalizeText(item?.mail || item?.signInAddress);
  if (mail.includes("@")) {
    return mail;
  }

  return "";
}

/**
 * Строка для System.AssignedTo: «Display Name <uniqueName>» или только имя.
 * @param {string} displayName
 * @param {string} uniqueName
 */
function buildAssignedToValue(displayName, uniqueName) {
  if (uniqueName && displayName) {
    return `${displayName} <${uniqueName}>`;
  }
  return uniqueName || displayName;
}

/**
 * Нормализует сохранённое значение AssignedTo.
 * Старый баг сохранял «Имя <samAccount>» без email/домена — ADO отклоняет такое.
 * В этом случае оставляем только display name.
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeAssignedToIdentity(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "";
  }

  const match = value.match(/^(.*)<([^>]+)>\s*$/);
  if (!match) {
    return value;
  }

  const displayName = normalizeText(match[1]);
  const uniqueName = normalizeText(match[2]);

  // Валидный unique name: DOMAIN\alias или email
  if (uniqueName.includes("\\") || uniqueName.includes("@")) {
    return buildAssignedToValue(displayName, uniqueName);
  }

  // Битый формат «Имя <Goreminsky>» — пробуем назначить по display name.
  return displayName || value;
}

/**
 * Готовит Assigned To для дизайн-лида.
 * Если в storage лежит email-формат (часто unknown на on-prem),
 * перезапрашивает identity API и предпочитает DOMAIN\alias.
 * Если резолв не удался — возвращает display name (без email).
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @returns {Promise<string>}
 */
async function resolveDesignLeadAssignedTo(config) {
  const stored = normalizeAssignedToIdentity(config.reviewDesignLead);
  if (!stored) {
    return "";
  }

  const match = stored.match(/^(.*)<([^>]+)>\s*$/);
  const displayName = match ? normalizeText(match[1]) : normalizeText(stored);
  const uniqueName = match ? normalizeText(match[2]) : "";

  // Уже DOMAIN\alias — оставляем как есть.
  if (uniqueName.includes("\\")) {
    return stored;
  }

  const query = displayName || uniqueName;
  if (query.length >= 2) {
    try {
      const results = await searchIdentities(config, query);
      const resolved = pickBestIdentityMatch(results, displayName, uniqueName);

      if (resolved?.assignedTo) {
        // Если снова пришёл только email — для on-prem надёжнее display name.
        if (resolved.uniqueName.includes("\\")) {
          return resolved.assignedTo;
        }
        if (resolved.displayName) {
          return resolved.displayName;
        }
        return resolved.assignedTo;
      }
    } catch (error) {
      logAdoError("resolveDesignLeadAssignedTo", error);
    }
  }

  // Email в Assigned To на on-prem часто даёт 400 unknown identity.
  if (uniqueName.includes("@")) {
    return displayName || stored;
  }

  return stored;
}

/**
 * @param {Array<{ displayName: string, uniqueName: string, assignedTo: string }>} results
 * @param {string} displayName
 * @param {string} uniqueName
 */
function pickBestIdentityMatch(results, displayName, uniqueName) {
  if (!Array.isArray(results) || !results.length) {
    return null;
  }

  const displayLower = displayName.toLowerCase();
  const uniqueLower = uniqueName.toLowerCase();

  const exact = results.find((item) => {
    const itemDisplay = normalizeText(item?.displayName).toLowerCase();
    const itemUnique = normalizeText(item?.uniqueName).toLowerCase();
    return (displayLower && itemDisplay === displayLower)
      || (uniqueLower && itemUnique === uniqueLower)
      || (uniqueLower && itemUnique.includes(uniqueLower));
  });

  if (exact) {
    return exact;
  }

  // Предпочитаем результат с DOMAIN\alias.
  return results.find((item) => String(item?.uniqueName ?? "").includes("\\"))
    ?? results[0];
}

/**
 * Читает строковое свойство identity (plain или `{ $value }`).
 * @param {Record<string, unknown>} properties
 * @param {string} key
 */
function readIdentityProperty(properties, key) {
  const raw = properties?.[key];
  if (raw && typeof raw === "object" && "$value" in raw) {
    return normalizeText(raw.$value);
  }
  return normalizeText(raw);
}

/**
 * Запасной поиск пользователей через REST Identities (если Identity Picker недоступен).
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {string} query
 */
async function searchIdentitiesViaIdentitiesApi(config, query) {
  const attempts = query.includes("@")
    ? [["MailAddress", query], ["General", query]]
    : [["General", query]];

  const root = normalizeApiRoot(config.apiRoot);
  const results = [];
  const seen = new Set();

  for (const [searchFilter, filterValue] of attempts) {
    const params = new URLSearchParams({
      searchFilter,
      filterValue,
      "api-version": "6.0",
    });

    let data;
    try {
      data = await adoFetch(config, `_apis/identities?${params.toString()}`);
    } catch (error) {
      logAdoError(`searchIdentities:identities:${searchFilter}`, error);
      continue;
    }

    for (const item of Array.isArray(data?.value) ? data.value : []) {
      const key = String(item?.descriptor || item?.id || "");
      if (key) {
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
      }

      const properties = item?.properties && typeof item.properties === "object"
        ? item.properties
        : {};
      const displayName = normalizeText(
        item?.customDisplayName || item?.providerDisplayName,
      );
      const uniqueName = resolveIdentityUniqueName({
        mail: readIdentityProperty(properties, "Mail")
          || readIdentityProperty(properties, "MailAddress"),
        signInAddress: readIdentityProperty(properties, "SignInAddress"),
        samAccountName: readIdentityProperty(properties, "Account")
          || readIdentityProperty(properties, "SamAccountName"),
        accountName: readIdentityProperty(properties, "Account"),
        domain: readIdentityProperty(properties, "Domain"),
      });
      const assignedTo = buildAssignedToValue(displayName, uniqueName);
      let avatarUrl = "";
      if (item?.id) {
        avatarUrl = `${root}/_api/_common/identityImage?id=${encodeURIComponent(item.id)}`;
      }

      if (displayName || uniqueName) {
        results.push({ displayName, uniqueName, assignedTo, avatarUrl });
      }
    }

    if (results.length) {
      break;
    }
  }

  return results;
}

/**
 * Ищет пользователей ADO по строке (для выбора «Дизайн-лида»).
 * Сначала Identity Picker, при сбое/пустом ответе — REST Identities.
 *
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {string} query
 * @returns {Promise<Array<{ displayName: string, uniqueName: string, assignedTo: string, avatarUrl: string }>>}
 */
export async function searchIdentities(config, query) {
  const q = String(query ?? "").trim();

  if (q.length < 2) {
    return [];
  }

  const search = new URLSearchParams({ "api-version": "5.0-preview.1" });
  const body = {
    query: q,
    identityTypes: ["user"],
    operationScopes: ["ims", "source"],
    properties: [
      "DisplayName",
      "Account",
      "Active",
      "Mail",
      "SamAccountName",
      "SignInAddress",
      "Domain",
    ],
    options: { MinResults: 5, MaxResults: 20 },
  };

  try {
    const data = await adoFetch(
      config,
      `_apis/IdentityPicker/Identities?${search.toString()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    const identities = data?.results?.[0]?.identities ?? [];
    const root = normalizeApiRoot(config.apiRoot);

    const mapped = identities
      .map((item) => {
        const displayName = normalizeText(item?.displayName);
        const uniqueName = resolveIdentityUniqueName(item);
        const assignedTo = buildAssignedToValue(displayName, uniqueName);

        const rawImage = normalizeText(item?.image);
        let avatarUrl = "";
        if (rawImage) {
          avatarUrl = rawImage.startsWith("http")
            ? rawImage
            : `${root}/${rawImage.replace(/^\//, "")}`;
        } else {
          const avatarId = item?.localId || item?.entityId || item?.originId;
          if (avatarId) {
            avatarUrl = `${root}/_api/_common/identityImage?id=${encodeURIComponent(avatarId)}`;
          }
        }

        return { displayName, uniqueName, assignedTo, avatarUrl };
      })
      .filter((item) => item.displayName || item.uniqueName);

    if (mapped.length) {
      return mapped;
    }
  } catch (error) {
    logAdoError("searchIdentities:picker", error);
  }

  return searchIdentitiesViaIdentitiesApi(config, q);
}

/**
 * Выполняет WIQL-запрос по work items, назначенным текущему пользователю.
 * Используем макрос @Me из WIQL, чтобы сервер сам сопоставил identity.
 *
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {{ ignoreIterationPath?: boolean, includeClosed?: boolean }} [options]
 */
export async function queryAssignedWorkItemIds(config, options = {}) {
  const ignoreIterationPath = Boolean(options.ignoreIterationPath);
  const includeClosed = Boolean(options.includeClosed);
  const project = encodeURIComponent(config.project.trim());

  const wiqlParts = [
    "SELECT [System.Id]",
    "FROM WorkItems",
    `WHERE [System.TeamProject] = '${config.project.replace(/'/g, "''")}'`,
    "  AND [System.AssignedTo] = @Me",
  ];

  if (!includeClosed) {
    wiqlParts.push("  AND [System.State] <> 'Closed'");
  }

  if (!ignoreIterationPath && config.iterationPath?.trim()) {
    const pathForWiql = wiqlPathWithoutClassificationIteration(config.iterationPath);
    const cleanPath = pathForWiql.replace(/'/g, "''");
    wiqlParts.push(`  AND [System.IterationPath] = '${cleanPath}'`);
  }

  wiqlParts.push("ORDER BY [System.ChangedDate] DESC");

  const wiql = wiqlParts.join(" ");

  const query = new URLSearchParams({
    "api-version": resolveApiVersion(config),
  });

  const pathAndQuery = `${project}/_apis/wit/wiql?${query.toString()}`;
  const requestUrl = `${normalizeApiRoot(config.apiRoot)}/${pathAndQuery}`;
  console.log("WIQL Request URL:", requestUrl);
  console.log("WIQL Query:", wiql);
  const data = await adoFetch(config, pathAndQuery, {
    method: "POST",
    body: JSON.stringify({ query: wiql }),
  });

  const refs = Array.isArray(data?.workItems) ? data.workItems : [];
  return refs
    .map((item) => Number(item?.id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * WIQL-поиск по назначенным @Me: без iteration из настроек, все состояния.
 * Использует оператор Contains на сервере — находит work items вне «текущей выборки» в UI.
 *
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {string} searchText
 */
export async function queryAssignedWorkItemIdsForSearch(config, searchText) {
  const raw = String(searchText ?? "").trim().replace(/\r?\n/g, " ");
  if (!raw) {
    return [];
  }

  const esc = raw.replace(/'/g, "''");
  const projectEsc = config.project.replace(/'/g, "''");
  const idDigits = raw.replace(/^#/, "").trim();
  const pureId = /^\d+$/.test(idDigits) ? Number(idDigits) : null;
  const idLine = pureId !== null && Number.isInteger(pureId) && pureId > 0
    ? `    OR [System.Id] = ${pureId}`
    : "";

  const wiqlParts = [
    "SELECT [System.Id]",
    "FROM WorkItems",
    `WHERE [System.TeamProject] = '${projectEsc}'`,
    "  AND [System.AssignedTo] = @Me",
    "  AND (",
    `    [System.Title] Contains '${esc}'`,
    `    OR [System.Description] Contains '${esc}'`,
  ];

  if (idLine) {
    wiqlParts.push(idLine);
  }

  wiqlParts.push("  )");
  wiqlParts.push("ORDER BY [System.CreatedDate] DESC");

  const wiql = wiqlParts.join("\n");
  const project = encodeURIComponent(config.project.trim());
  const query = new URLSearchParams({
    "api-version": resolveApiVersion(config),
  });
  const pathAndQuery = `${project}/_apis/wit/wiql?${query.toString()}`;

  const data = await adoFetch(config, pathAndQuery, {
    method: "POST",
    body: JSON.stringify({ query: wiql }),
  });

  const refs = Array.isArray(data?.workItems) ? data.workItems : [];
  return refs
    .map((item) => Number(item?.id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {number[]} ids
 */
export async function fetchWorkItemsByIds(config, ids) {
  const out = [];

  for (let offset = 0; offset < ids.length; offset += WORK_ITEMS_BATCH_SIZE) {
    const chunk = ids.slice(offset, offset + WORK_ITEMS_BATCH_SIZE);

    if (!chunk.length) {
      continue;
    }

    const project = encodeURIComponent(config.project.trim());
    const query = new URLSearchParams({
      "api-version": resolveApiVersion(config),
    });

    const data = await adoFetch(
      config,
      `${project}/_apis/wit/workitemsbatch?${query.toString()}`,
      {
        method: "POST",
        body: JSON.stringify({
          ids: chunk,
          fields: [
            "System.Id",
            "System.Title",
            "System.WorkItemType",
            "System.State",
            "System.AssignedTo",
            "System.CreatedDate",
            "System.ChangedDate",
            "System.Description",
            "System.TeamProject",
            "System.AreaPath",
            "System.IterationPath",
          ],
        }),
      },
    );

    out.push(...(Array.isArray(data?.value) ? data.value : []));
  }

  return out;
}

/**
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {string} type
 */
export async function fetchWorkItemTypeStates(config, type) {
  const normalizedType = normalizeText(type);

  if (!normalizedType) {
    return [];
  }

  const project = encodeURIComponent(config.project.trim());
  const typeSeg = encodeURIComponent(normalizedType);
  const query = new URLSearchParams({
    "api-version": resolveApiVersion(config),
  });
  const data = await adoFetch(
    config,
    `${project}/_apis/wit/workitemtypes/${typeSeg}/states?${query.toString()}`,
  );
  const states = Array.isArray(data?.value) ? data.value : [];

  return states
    .map((entry) => ({
      name: normalizeText(entry?.name),
      category: normalizeStateCategory(entry?.category),
    }))
    .filter((entry) => Boolean(entry.name));
}

/**
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {number|string} workItemId
 * @param {string} nextState
 */
export async function updateWorkItemState(config, workItemId, nextState) {
  const id = Number(workItemId);
  const state = normalizeText(nextState);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Некорректный id work item для изменения статуса.");
  }

  if (!state) {
    throw new Error("Не указан новый статус work item.");
  }

  const project = encodeURIComponent(config.project.trim());
  const query = new URLSearchParams({
    "api-version": resolveApiVersion(config),
  });

  await adoFetch(
    config,
    `${project}/_apis/wit/workitems/${id}?${query.toString()}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json-patch+json",
      },
      body: JSON.stringify([
        {
          op: "add",
          path: "/fields/System.State",
          value: state,
        },
      ]),
    },
  );
}

/**
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {string[]} types
 */
export async function resolveStateCategoriesByType(config, types) {
  const distinctTypes = [...new Set(types.map((type) => normalizeText(type)).filter(Boolean))];
  const entries = await Promise.all(
    distinctTypes.map(async (type) => [type, await fetchStateMapForType(config, type)]),
  );

  return new Map(entries);
}

/**
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {string[]} types
 */
export async function resolveWorkItemTypeIcons(config, types) {
  const distinctTypes = [...new Set(types.map((type) => normalizeText(type)).filter(Boolean))];

  if (!distinctTypes.length) {
    return new Map();
  }

  try {
    const [processId, iconsCatalog] = await Promise.all([
      fetchProjectProcessId(config),
      fetchWorkItemIconsCatalog(config),
    ]);

    if (!processId) {
      return new Map();
    }

    const query = new URLSearchParams({
      "api-version": resolveApiVersion(config),
    });
    const data = await adoFetch(
      config,
      `_apis/work/processes/${encodeURIComponent(processId)}/workitemtypes?${query.toString()}`,
    );
    const value = Array.isArray(data?.value) ? data.value : [];
    const out = new Map();

    for (const entry of value) {
      const typeName = normalizeText(entry?.name);

      if (!typeName || !distinctTypes.includes(typeName)) {
        continue;
      }

      const iconId = normalizeText(entry?.icon);
      const color = normalizeColor(entry?.color);
      const iconUrl = iconId
        ? buildWorkItemIconUrl(iconsCatalog.get(iconId) ?? "", color)
        : "";

      out.set(typeName, {
        iconId,
        iconUrl,
        color,
      });
    }

    return out;
  } catch (error) {
    logAdoError("resolveWorkItemTypeIcons", error);
    return new Map();
  }
}

async function fetchStateMapForType(config, type) {
  const cacheKey = [
    normalizeApiRoot(config.apiRoot),
    config.project.trim(),
    resolveApiVersion(config),
    type,
  ].join("|");
  const now = Date.now();
  const cached = typeStatesCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const project = encodeURIComponent(config.project.trim());
  const typeSeg = encodeURIComponent(type);
  const query = new URLSearchParams({
    "api-version": resolveApiVersion(config),
  });
  const data = await adoFetch(
    config,
    `${project}/_apis/wit/workitemtypes/${typeSeg}/states?${query.toString()}`,
  );

  const map = new Map();
  const states = Array.isArray(data?.value) ? data.value : [];

  for (const state of states) {
    const name = normalizeText(state?.name);
    const category = normalizeStateCategory(state?.category);

    if (name && category) {
      map.set(name.toLowerCase(), category);
    }
  }

  typeStatesCache.set(cacheKey, {
    expiresAt: now + TYPE_STATES_CACHE_TTL_MS,
    value: map,
  });

  return map;
}

export function mapWorkItemToItem(workItem, config, stateCategoriesByType, typeIconsByName = new Map(), mapOptions = {}) {
  const includeClosed = Boolean(mapOptions.includeClosed);
  const fields = workItem?.fields ?? {};
  const id = Number(workItem?.id);
  const type = normalizeText(fields["System.WorkItemType"]);
  const state = normalizeText(fields["System.State"]);
  const title = normalizeText(fields["System.Title"]);

  if (!Number.isInteger(id) || !title) {
    return null;
  }

  const category = resolveWorkItemStateCategory(type, state, stateCategoriesByType);
  const typeIcon = typeIconsByName.get(type) ?? null;

  if (category === "closed" && !includeClosed) {
    return null;
  }

  return {
    id: String(id),
    title,
    type,
    state,
    stateCategory: category,
    url: buildWorkItemWebUrl(config.apiRoot, fields["System.TeamProject"], id, workItem),
    assignedTo: pickAssignedDisplayName(fields["System.AssignedTo"]),
    typeIconUrl: typeIcon?.iconUrl ?? "",
    typeIconId: typeIcon?.iconId ?? "",
    createdAt: normalizeIsoDate(fields["System.CreatedDate"]),
    updatedAt: normalizeIsoDate(fields["System.ChangedDate"]),
    description: normalizeDescription(fields["System.Description"]),
  };
}

async function fetchProjectProcessId(config) {
  const cacheKey = [normalizeApiRoot(config.apiRoot), config.project.trim()].join("|");

  if (projectProcessIdCache.has(cacheKey)) {
    return projectProcessIdCache.get(cacheKey);
  }

  const project = encodeURIComponent(config.project.trim());
  const query = new URLSearchParams({
    includeCapabilities: "true",
    "api-version": resolveApiVersion(config),
  });
  const data = await adoFetch(config, `_apis/projects/${project}?${query.toString()}`);
  const processId = normalizeText(
    data?.capabilities?.processTemplate?.templateTypeId
      ?? data?.capabilities?.processTemplate?.templateId
      ?? data?.capabilities?.processTemplate?.id
      ?? "",
  );

  projectProcessIdCache.set(cacheKey, processId);
  return processId;
}

async function fetchWorkItemIconsCatalog(config) {
  const cacheKey = normalizeApiRoot(config.apiRoot);

  if (workItemIconsCatalogCache.has(cacheKey)) {
    return workItemIconsCatalogCache.get(cacheKey);
  }

  const query = new URLSearchParams({
    "api-version": resolveApiVersion(config),
  });
  const data = await adoFetch(config, `_apis/wit/workitemicons?${query.toString()}`);
  const value = Array.isArray(data?.value) ? data.value : [];
  const map = new Map();

  for (const icon of value) {
    const id = normalizeText(icon?.id);
    const url = normalizeText(icon?.url);

    if (id && url) {
      map.set(id, url);
    }
  }

  workItemIconsCatalogCache.set(cacheKey, map);
  return map;
}

function buildWorkItemIconUrl(baseUrl, color) {
  const normalizedBaseUrl = normalizeText(baseUrl);

  if (!normalizedBaseUrl) {
    return "";
  }

  if (!color) {
    return normalizedBaseUrl;
  }

  const join = normalizedBaseUrl.includes("?") ? "&" : "?";
  return `${normalizedBaseUrl}${join}color=${encodeURIComponent(color)}`;
}

function normalizeColor(value) {
  const color = normalizeText(value).replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(color) ? color : "";
}

export function sortWorkItemsNewestFirst(items) {
  return [...items].sort((left, right) => {
    const byUpdated = compareDatesDesc(left.updatedAt, right.updatedAt);
    return byUpdated || Number(right.id) - Number(left.id);
  });
}

function compareDatesDesc(left, right) {
  const leftTime = toTimestamp(left);
  const rightTime = toTimestamp(right);
  return rightTime - leftTime;
}

function toTimestamp(value) {
  const date = value ? new Date(value) : null;
  const time = date?.getTime?.() ?? NaN;
  return Number.isFinite(time) ? time : 0;
}

function pickAssignedDisplayName(assignedTo) {
  if (!assignedTo || typeof assignedTo !== "object") {
    return "";
  }

  return normalizeText(
    assignedTo.displayName
      ?? assignedTo.name
      ?? assignedTo.uniqueName
      ?? assignedTo.descriptor
      ?? "",
  );
}

function resolveWorkItemStateCategory(type, state, stateCategoriesByType) {
  const typeStates = stateCategoriesByType.get(type) ?? new Map();
  const fromApi = typeStates.get(state.toLowerCase());

  if (fromApi) {
    return fromApi;
  }

  return inferStateCategory(state);
}

function inferStateCategory(state) {
  const normalized = state.toLowerCase();

  if (!normalized) {
    return "active";
  }

  if (/(closed|done|completed|complete|removed)/i.test(normalized)) {
    return "closed";
  }

  if (/(resolved|ready for testing|fixed)/i.test(normalized)) {
    return "resolved";
  }

  if (/(new|proposed|approved|triaged)/i.test(normalized)) {
    return "proposed";
  }

  return "active";
}

function normalizeStateCategory(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (normalized === "completed") {
    return "closed";
  }

  if (["proposed", "resolved", "active", "closed"].includes(normalized)) {
    return normalized;
  }

  return "";
}

function buildWorkItemWebUrl(apiRoot, project, id, workItem) {
  const fromLinks = workItem?._links?.html?.href ?? workItem?._links?.web?.href;

  if (typeof fromLinks === "string" && fromLinks.startsWith("http")) {
    return fromLinks;
  }

  const projectSeg = encodeURIComponent(normalizeText(project));
  return `${normalizeApiRoot(apiRoot)}/${projectSeg}/_workitems/edit/${id}`;
}

function normalizeDescription(value) {
  return String(value ?? "")
    .replace(/\\n/g, "\n")
    .trim();
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeIsoDate(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const dotNetMatch = value.match(/\/Date\(([-+]?\d+)/i);

  if (dotNetMatch) {
    const timestamp = Number(dotNetMatch[1]);

    if (Number.isFinite(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function logAdoError(context, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ado] ${context}: ${message}`, error);
}

/**
 * Возвращает исходный work item по id (авторитетные данные для FR-003).
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {number|string} workItemId
 */
export async function fetchWorkItemById(config, workItemId) {
  const id = Number(workItemId);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Некорректный id исходной задачи.");
  }

  const items = await fetchWorkItemsByIds(config, [id]);
  const workItem = Array.isArray(items) ? items[0] : null;

  if (!workItem) {
    throw new Error("Исходная задача не найдена (404): проверьте номер задачи.");
  }

  return workItem;
}

function escapeAdoHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Поля шаблона, которые нельзя переносить в patch создания напрямую
// (id-поля дублируют path-варианты, а *-Add — служебные ключи шаблонов).
const TEMPLATE_SKIP_FIELDS = new Set([
  "System.AreaId",
  "System.IterationId",
  // Assigned To задаём только из настроек дизайн-лида; значение из шаблона
  // часто не резолвится на on-prem и валит создание с HTTP 400.
  "System.AssignedTo",
]);

/**
 * Читает поля командного шаблона задачи на ревью (work item template).
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function fetchReviewTemplateFields(config) {
  const templateId = String(config.reviewTemplateId ?? "").trim();
  const team = String(config.reviewTemplateTeam ?? "").trim();

  if (!templateId || !team) {
    return null;
  }

  const project = encodeURIComponent(resolveReviewProject(config));
  const teamSeg = encodeURIComponent(team);
  const query = new URLSearchParams({
    "api-version": resolveApiVersion(config),
  });

  const data = await adoFetch(
    config,
    `${project}/${teamSeg}/_apis/wit/templates/${encodeURIComponent(templateId)}?${query.toString()}`,
  );

  return data?.fields ?? null;
}

/** Подставляет ссылку исходной задачи в раздел «Продуктовая задача» описания шаблона (FR-010).
 * Ссылкой является тип и номер задачи («Task 9663335»), название идёт обычным текстом.
 * Если передан pixsoUrl — заменяет плейсхолдер раздела «Макеты» на ссылку. */
function applyReviewDescription(templateDescription, placeholder, source, pixsoUrl = "") {
  const { title, url, id, type } = source;
  const linkLabel = `${type ? `${type} ` : ""}${id}`.trim();
  const linkHtml =
    `<a href="${escapeAdoHtml(url)}">${escapeAdoHtml(linkLabel)}</a>: ${escapeAdoHtml(title)}`;
  let result = String(templateDescription ?? "");
  const placeholderText = String(placeholder ?? "").trim();

  if (placeholderText && result.includes(placeholderText)) {
    result = result.split(placeholderText).join(linkHtml);
  } else {
    const prodBlock = `<div><b>Продуктовая задача</b></div><div>${linkHtml}</div>`;
    result = result ? `${prodBlock}${result}` : prodBlock;
  }

  const layoutsPlaceholder = "Ссылка на макеты в Pixso (не забудьте дать доступ на редактирование команде ДС)";
  const pixso = String(pixsoUrl ?? "").trim();
  if (pixso && result.includes(layoutsPlaceholder)) {
    const pixsoLinkHtml =
      `<a href="${escapeAdoHtml(pixso)}">${escapeAdoHtml(pixso)}</a>`;
    result = result.split(layoutsPlaceholder).join(pixsoLinkHtml);
  }

  return result;
}

/**
 * Создаёт задачу на ревью из задачи на дизайн по командному шаблону и проставляет связи.
 * Возвращает id/url созданной задачи и предупреждения о частичных сбоях (FR-014).
 *
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {{ sourceId: number|string, pixsoUrl?: string }} source
 */
export async function createReviewWorkItem(config, source) {
  const sourceId = Number(source?.sourceId);

  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw new Error("Исходная задача ещё не сохранена или не имеет номера.");
  }

  const type = String(config.reviewWorkItemType ?? "").trim() || "Review";

  // FR-003: авторитетно читаем данные исходной задачи с сервера.
  const sourceWorkItem = await fetchWorkItemById(config, sourceId);
  const fields = sourceWorkItem.fields ?? {};
  const sourceTitle = normalizeText(fields["System.Title"]);
  const sourceType = normalizeText(fields["System.WorkItemType"]);
  const sourceProject = normalizeText(fields["System.TeamProject"]) || config.project.trim();

  if (!sourceTitle) {
    throw new Error("Не удалось определить заголовок исходной задачи.");
  }

  const sourceUrl = buildWorkItemWebUrl(config.apiRoot, sourceProject, sourceId, sourceWorkItem);
  const placeholder = String(config.reviewPlaceholderText ?? "").trim() || "Название и ссылка на задачу";
  const pixsoUrl = String(source?.pixsoUrl ?? "").trim();

  // Поля создаваемой задачи: берём из шаблона, при недоступности — минимальный набор.
  let templateFields = null;
  try {
    templateFields = await fetchReviewTemplateFields(config);
  } catch (error) {
    logAdoError("createReviewWorkItem:template", error);
    templateFields = null;
  }

  const createFields = {};

  if (templateFields) {
    for (const [ref, value] of Object.entries(templateFields)) {
      if (TEMPLATE_SKIP_FIELDS.has(ref) || ref.endsWith("-Add")) {
        continue;
      }
      createFields[ref] = value;
    }
  } else {
    // Резервные обязательные поля типа Review.
    createFields["KL.SizeSymbol"] = "M";
    createFields["KL.Design"] = "New";
  }

  // FR-008: заголовок из исходной задачи; при заданном названии продукта — «[Продукт] …».
  const productName = String(config.reviewProductName ?? "").trim();
  createFields["System.Title"] = productName ? `[${productName}] ${sourceTitle}` : sourceTitle;

  // Если указан дизайн-лид — назначаем задачу на него.
  // В storage мог остаться email-формат, который on-prem TFS не принимает —
  // перезапрашиваем Identity Picker и предпочитаем DOMAIN\alias.
  const designLead = await resolveDesignLeadAssignedTo(config);
  if (designLead) {
    createFields["System.AssignedTo"] = designLead;
  }
  createFields["System.Description"] = applyReviewDescription(
    templateFields?.["System.Description"],
    placeholder,
    { title: sourceTitle, url: sourceUrl, id: sourceId, type: sourceType },
    pixsoUrl,
  );

  const patch = Object.entries(createFields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([ref, value]) => ({ op: "add", path: `/fields/${ref}`, value }));

  const reviewProject = resolveReviewProject(config);
  const project = encodeURIComponent(reviewProject);
  const typeSeg = `$${encodeURIComponent(type)}`;
  const query = new URLSearchParams({
    "api-version": resolveApiVersion(config),
  });

  const createOptions = {
    method: "POST",
    headers: {
      "Content-Type": "application/json-patch+json",
    },
    body: JSON.stringify(patch),
  };

  // FR-007: создание work item типа Review всегда в reviewProject из настроек.
  let created;
  const warnings = [];
  try {
    created = await adoFetch(
      config,
      `${project}/_apis/wit/workitems/${typeSeg}?${query.toString()}`,
      createOptions,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const assignedToUnknown = /unknown identity/i.test(message)
      && /Assigned To/i.test(message)
      && createFields["System.AssignedTo"];

    if (!assignedToUnknown) {
      throw error;
    }

    logAdoError("createReviewWorkItem:assignedTo", error);

    const assignedCandidates = [];
    const failedAssignedTo = String(createFields["System.AssignedTo"]);
    const nameOnlyMatch = failedAssignedTo.match(/^(.*)<[^>]+>\s*$/);
    const nameOnly = nameOnlyMatch ? normalizeText(nameOnlyMatch[1]) : "";
    if (nameOnly && nameOnly !== failedAssignedTo) {
      assignedCandidates.push(nameOnly);
    }

    let assignedFixed = false;
    for (const candidate of assignedCandidates) {
      createFields["System.AssignedTo"] = candidate;
      const retryPatch = Object.entries(createFields)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([ref, value]) => ({ op: "add", path: `/fields/${ref}`, value }));

      try {
        created = await adoFetch(
          config,
          `${project}/_apis/wit/workitems/${typeSeg}?${query.toString()}`,
          {
            ...createOptions,
            body: JSON.stringify(retryPatch),
          },
        );
        assignedFixed = true;
        break;
      } catch (retryError) {
        logAdoError("createReviewWorkItem:assignedToRetry", retryError);
      }
    }

    if (!assignedFixed) {
      // Identity не резолвится — создаём без Assigned To (ADO назначит создателя).
      delete createFields["System.AssignedTo"];
      const patchWithoutAssignee = Object.entries(createFields)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([ref, value]) => ({ op: "add", path: `/fields/${ref}`, value }));

      created = await adoFetch(
        config,
        `${project}/_apis/wit/workitems/${typeSeg}?${query.toString()}`,
        {
          ...createOptions,
          body: JSON.stringify(patchWithoutAssignee),
        },
      );
      warnings.push(
        `Не удалось назначить дизайн-лида (${designLead}): identity не распознана. Назначьте вручную.`,
      );
    }
  }

  const reviewId = Number(created?.id);

  if (!Number.isInteger(reviewId) || reviewId <= 0) {
    throw new Error("Не удалось создать задачу на ревью: сервер не вернул номер задачи.");
  }

  const reviewUrl = buildWorkItemWebUrl(config.apiRoot, reviewProject, reviewId, created);

  // FR-012: связь Related с исходной задачей.
  try {
    await addWorkItemRelation(
      config,
      reviewId,
      "System.LinkTypes.Related",
      buildWorkItemApiUrl(config, sourceId),
      reviewProject,
    );
  } catch (error) {
    logAdoError("createReviewWorkItem:related", error);
    warnings.push(
      `Связь Related с исходной задачей #${sourceId} не добавлена: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // FR-013: привязка как child к родительской задаче из настроек (child → parent).
  const parentId = parseReviewParentId(config.reviewParentId);
  if (parentId) {
    try {
      await addWorkItemRelation(
        config,
        reviewId,
        "System.LinkTypes.Hierarchy-Reverse",
        buildWorkItemApiUrl(config, parentId),
        reviewProject,
      );
    } catch (error) {
      logAdoError("createReviewWorkItem:parent", error);
      warnings.push(
        `Привязка к родителю #${parentId} не выполнена: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    id: reviewId,
    url: reviewUrl,
    title: sourceTitle,
    warnings,
  };
}

/** Ссылка на work item в REST API — используется как target для связей. */
function buildWorkItemApiUrl(config, id) {
  return `${normalizeApiRoot(config.apiRoot)}/_apis/wit/workItems/${Number(id)}`;
}

/**
 * Добавляет связь к work item отдельным PATCH-запросом.
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {number} workItemId
 * @param {string} rel
 * @param {string} targetUrl
 * @param {string} [projectName] проект WI; по умолчанию `config.project`
 */
async function addWorkItemRelation(config, workItemId, rel, targetUrl, projectName) {
  const project = encodeURIComponent(
    String(projectName ?? config.project).trim() || config.project.trim(),
  );
  const query = new URLSearchParams({
    "api-version": resolveApiVersion(config),
  });

  await adoFetch(
    config,
    `${project}/_apis/wit/workitems/${Number(workItemId)}?${query.toString()}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json-patch+json",
      },
      body: JSON.stringify([
        {
          op: "add",
          path: "/relations/-",
          value: { rel, url: targetUrl },
        },
      ]),
    },
  );
}

/**
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {number} workItemId
 */
export async function fetchWorkItemComments(config, workItemId) {
  const id = Number(workItemId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Некорректный id work item для загрузки комментариев.");
  }

  try {
    const project = encodeURIComponent(config.project.trim());
    const query = new URLSearchParams({
      "api-version": resolveApiVersion(config),
    });
    const data = await adoFetch(
      config,
      `${project}/_apis/wit/workItems/${id}/comments?${query.toString()}`,
    );

    const comments = Array.isArray(data?.value) ? data.value : Array.isArray(data?.comments) ? data.comments : [];
    const out = [];

    for (const comment of comments) {
      const createdBy = comment?.createdBy ?? {};
      out.push({
        id: String(comment?.id ?? ""),
        author: normalizeText(createdBy?.displayName || createdBy?.uniqueName || createdBy?.name || "Неизвестный"),
        avatarUrl: normalizeText(createdBy?.imageUrl || createdBy?._links?.avatar?.href || createdBy?.url || ""),
        createdAt: normalizeIsoDate(comment?.createdDate),
        text: comment?.text ?? "",
      });
    }

    return out.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  } catch (error) {
    if (error.message.includes("404")) {
      return [];
    }
    throw error;
  }
}

/**
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {number} workItemId
 * @param {string} text
 */
export async function createWorkItemComment(config, workItemId, text) {
  const id = Number(workItemId);
  const commentText = String(text ?? "").trim();

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Некорректный id work item для добавления комментария.");
  }

  if (!commentText) {
    throw new Error("Комментарий не может быть пустым.");
  }

  // Convert newlines to HTML <br> tags for proper display in Azure DevOps
  const htmlText = commentText.replace(/\n/g, '<br>');

  const project = encodeURIComponent(config.project.trim());
  const query = new URLSearchParams({
    "api-version": resolveApiVersion(config),
  });

  // For older Azure DevOps Server versions, add comment via work item update
  await adoFetch(
    config,
    `${project}/_apis/wit/workitems/${id}?${query.toString()}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json-patch+json",
      },
      body: JSON.stringify([
        {
          op: "add",
          path: "/fields/System.History",
          value: htmlText,
        },
      ]),
    },
  );
}
export async function fetchProjectWorkItemTypes(config) {
  const project = encodeURIComponent(config.project.trim());
  const query = new URLSearchParams({ "api-version": resolveApiVersion(config) });
  const data = await adoFetch(config, `${project}/_apis/wit/workitemtypes?${query.toString()}`);
  const value = Array.isArray(data?.value) ? data.value : [];
  return value.map((entry) => ({
    name: normalizeText(entry?.name),
    referenceName: normalizeText(entry?.referenceName),
    iconUrl: normalizeText(entry?.icon?.url),
    color: normalizeText(entry?.color),
    isDisabled: Boolean(entry?.isDisabled),
  })).filter((t) => t.name && !t.isDisabled);
}

/**
 * Существующие тэги проекта. Если эндпоинт недоступен — пустой список (ручной ввод остаётся).
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @returns {Promise<string[]>}
 */
export async function fetchProjectTags(config) {
  const project = encodeURIComponent(config.project.trim());
  const base = resolveApiVersion(config);
  // Список тэгов — preview-ресурс, ему нужен минорный суффикс версии
  // (например 6.0-preview.2). Пробуем сначала как есть, затем с суффиксом.
  const versions = [];
  versions.push(base);
  if (/-preview$/i.test(base)) {
    versions.push(`${base}.2`, `${base}.1`);
  }

  for (const version of versions) {
    try {
      const query = new URLSearchParams({ "api-version": version });
      const data = await adoFetch(config, `${project}/_apis/wit/tags?${query.toString()}`);
      const value = Array.isArray(data?.value) ? data.value : [];
      const names = value.map((t) => normalizeText(t?.name)).filter(Boolean);
      if (names.length || !/-preview$/i.test(base)) {
        return names;
      }
    } catch (error) {
      logAdoError(`fetchProjectTags(${version})`, error);
    }
  }
  return [];
}

/**
 * Типы связей work item (как в TFS).
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @returns {Promise<Array<{referenceName:string,name:string}>>}
 */
export async function fetchWorkItemRelationTypes(config) {
  const query = new URLSearchParams({ "api-version": resolveApiVersion(config) });
  const data = await adoFetch(config, `_apis/wit/workitemrelationtypes?${query.toString()}`);
  const value = Array.isArray(data?.value) ? data.value : [];
  return value
    .map((entry) => ({
      referenceName: normalizeText(entry?.referenceName),
      name: normalizeText(entry?.name),
    }))
    .filter((t) => t.referenceName && t.name);
}

/**
 * Поиск work item по проекту: точное совпадение по ID или Contains по заголовку.
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {string} text
 * @returns {Promise<Array<{id:number,title:string,type:string}>>}
 */
/**
 * Поиск задач для связи. Возвращает { results, idsFound, mode } (debug — mode/idsFound
 * для диагностики). Точный номер читаем напрямую по ID (надёжнее, чем WIQL Contains,
 * который на части on-prem TFS не индексирован); иначе — текстовый WIQL по проекту.
 */
export async function searchWorkItems(config, text) {
  const term = String(text ?? "").trim();
  if (!term) {
    return { results: [], idsFound: 0, mode: "empty" };
  }

  const toResult = (wi) => {
    const f = wi?.fields ?? {};
    return {
      id: Number(wi?.id),
      title: normalizeText(f["System.Title"]),
      type: normalizeText(f["System.WorkItemType"]),
      project: normalizeText(f["System.TeamProject"]),
    };
  };

  const idDigits = term.replace(/^#/, "").trim();
  const pureId = /^\d+$/.test(idDigits) ? Number(idDigits) : null;

  // Точный номер — читаем задачу напрямую (тот же путь, что и чтение исходной задачи).
  if (pureId !== null && pureId > 0) {
    try {
      const wi = await fetchWorkItemById(config, pureId);
      const result = toResult(wi);
      return { results: result.id > 0 ? [result] : [], idsFound: result.id > 0 ? 1 : 0, mode: "byId" };
    } catch (error) {
      logAdoError("searchWorkItems:byId", error);
      return { results: [], idsFound: 0, mode: "byId-miss" };
    }
  }

  // Текстовый поиск — WIQL Contains по проекту.
  const project = config.project.trim();
  const esc = term.replace(/'/g, "''");
  const projectEsc = project.replace(/'/g, "''");
  const wiql = [
    "SELECT [System.Id]",
    "FROM WorkItems",
    `WHERE [System.TeamProject] = '${projectEsc}'`,
    "  AND (",
    `    [System.Title] Contains '${esc}'`,
    `    OR [System.Description] Contains '${esc}'`,
    "  )",
    "ORDER BY [System.CreatedDate] DESC",
  ].join("\n");

  const query = new URLSearchParams({ "api-version": resolveApiVersion(config) });
  const data = await adoFetch(
    config,
    `${encodeURIComponent(project)}/_apis/wit/wiql?${query.toString()}`,
    {
      method: "POST",
      body: JSON.stringify({ query: wiql }),
    },
  );

  const ids = (Array.isArray(data?.workItems) ? data.workItems : [])
    .map((w) => Number(w?.id))
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 50);
  if (!ids.length) {
    return { results: [], idsFound: 0, mode: "text" };
  }

  const items = await fetchWorkItemsByIds(config, ids);
  const order = new Map(ids.map((id, index) => [id, index]));
  const results = items
    .map(toResult)
    .filter((wi) => Number.isInteger(wi.id) && wi.id > 0)
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  return { results, idsFound: ids.length, mode: "text" };
}

/**
 * Создаёт Work Item по конфигу пользовательской кнопки.
 * @param {import("./ado-config.mjs").DEFAULT_ADO_CONFIG} config
 * @param {object} buttonConfig
 * @param {{sourceId:number}} source
 * @returns {Promise<{id:number,url:string,title:string,warnings:string[]}>}
 */
export async function createCustomWorkItem(config, buttonConfig, source) {
  const sourceId = Number(source?.sourceId);
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw new Error("Исходная задача ещё не сохранена или не имеет номера.");
  }

  const type = String(buttonConfig?.wiType ?? "").trim();
  if (!type) {
    throw new Error("Не задан тип создаваемой задачи.");
  }

  const sourceWorkItem = await fetchWorkItemById(config, sourceId);
  const fields = sourceWorkItem.fields ?? {};
  const sourceTitle = normalizeText(fields["System.Title"]);
  const sourceProject = normalizeText(fields["System.TeamProject"]) || config.project.trim();

  const createFields = buildCustomWorkItemFields(buttonConfig, {
    title: sourceTitle,
    areaPath: normalizeText(fields["System.AreaPath"]),
    iterationPath: normalizeText(fields["System.IterationPath"]),
    description: fields["System.Description"] ?? "",
  });

  if (!String(createFields["System.Title"] ?? "").trim()) {
    throw new Error("Название задачи не задано (и не удалось взять из исходной задачи).");
  }

  const patch = Object.entries(createFields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([ref, value]) => ({ op: "add", path: `/fields/${ref}`, value }));

  const project = encodeURIComponent(sourceProject);
  const typeSeg = `$${encodeURIComponent(type)}`;
  const query = new URLSearchParams({ "api-version": resolveApiVersion(config) });

  const created = await adoFetch(
    config,
    `${project}/_apis/wit/workitems/${typeSeg}?${query.toString()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json-patch+json" },
      body: JSON.stringify(patch),
    },
  );

  const newId = Number(created?.id);
  if (!Number.isInteger(newId) || newId <= 0) {
    throw new Error("Сервер не вернул номер созданной задачи.");
  }

  const newUrl = buildWorkItemWebUrl(config.apiRoot, sourceProject, newId, created);
  const warnings = [];

  const links = Array.isArray(buttonConfig?.links) ? buttonConfig.links : [];
  for (const link of links) {
    const relType = String(link?.relType ?? "").trim();
    // «Привязать к родительской задаче» — целью связи становится исходная задача,
    // из которой нажата кнопка. Иначе — выбранная в поиске задача.
    const targetId = link?.toParent ? sourceId : parseWorkItemId(link?.targetId);
    if (!relType || !targetId) {
      continue;
    }
    try {
      await addWorkItemRelation(config, newId, relType, buildWorkItemApiUrl(config, targetId), sourceProject);
    } catch (error) {
      logAdoError("createCustomWorkItem:link", error);
      warnings.push(
        `Связь ${relType} → #${targetId} не добавлена: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { id: newId, url: newUrl, title: createFields["System.Title"], warnings };
}
