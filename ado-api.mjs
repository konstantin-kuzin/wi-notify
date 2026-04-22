import {
  normalizeApiRoot,
  resolveApiVersion,
} from "./ado-config.mjs";

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 900;
const WORK_ITEMS_BATCH_SIZE = 200;
const TYPE_STATES_CACHE_TTL_MS = 5 * 60 * 1000;
const typeStatesCache = new Map();
const workItemTypeIconCache = new Map();
const workItemIconsCatalogCache = new Map();
const projectProcessIdCache = new Map();

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
    const response = await fetch(url, {
      ...init,
      headers,
      credentials: config.authMode === "session" ? "include" : "omit",
      cache: "no-store",
    });

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