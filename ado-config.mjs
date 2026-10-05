export const ADO_CONFIG_KEY = "adoConfig";

/** Базовые настройки подключения к Azure DevOps. */
export const DEFAULT_ADO_CONFIG = {
  apiRoot: "https://hqrndtfs.avp.ru/tfs/DefaultCollection",
  project: "Monorepo",
  /**
   * Сохранённый Query проекта (`_apis/wit/queries`). Пусто — список всех задач
   * текущего пользователя (`System.AssignedTo = @Me`).
   */
  workItemQueryId: "",
  /** Имя выбранного Query для подписи в popup, пока список запросов ещё не загружен. */
  workItemQueryName: "",
  refreshIntervalMinutes: 10,
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
  /**
   * Настройки сценария «Создать задачу на ревью».
   * `reviewEnabled` — включать ли сценарий: тоггл в настройках; при `false` блок свёрнут
   *   и пункт в меню «...» формы WI не показывается.
   * `reviewProject` — Team Project, в котором всегда создаётся задача на ревью
   *   (независимо от `project` в основных настройках / проекта исходной WI). Редактируется в настройках.
   * `reviewWorkItemType` — тип создаваемого work item (по умолчанию `Review`). Без UI.
   * `reviewTemplateUrl` — полная или частичная ссылка на страницу создания задачи на ревью
   *   (страница содержит templateId и ownerId). Система извлекает из неё templateId (GUID шаблона)
   *   и ownerId (ID команды) для запроса полей шаблона по API. Редактируется в настройках.
   * `reviewDesignTypes` — типы исходных задач, для которых показывать пункт «Design Review»
   *   в меню «...» (через запятую); например `Task,Mockup,Requirement`. Пусто — для всех.
   *   Редактируется в настройках (поле «Где показывать»).
   * `reviewPlaceholderText` — текст-плейсхолдер в разделе «Продуктовая задача» шаблона, который
   *   заменяется на имя и ссылку исходной задачи (FR-010). Без UI.
   * `reviewParentId` — номер родительской задачи; созданная задача привязывается к ней как child
   *   (связь child → parent). Пусто — родительскую связь не добавлять. Редактируется в настройках.
   * `reviewProductName` — название продукта; добавляется в заголовок задачи на ревью в квадратных
   *   скобках перед названием исходной задачи (например «[Product] …»). Пусто — не добавлять.
   * `reviewDesignLead` — строка identity для System.AssignedTo
   *   («Имя <email>» или «Имя <DOMAIN\\alias>»); если задана, созданная задача
   *   назначается на этого пользователя. Пусто — не назначать.
   * `reviewDesignLeadName` — отображаемое имя дизайн-лида (для показа в поле настроек).
   */
  reviewEnabled: true,
  reviewProject: "",
  reviewWorkItemType: "Review",
  reviewTemplateUrl: "",
  reviewDesignTypes: "Task,Mockup,Requirement",
  reviewPlaceholderText: "Название и ссылка на задачу",
  reviewParentId: "",
  reviewProductName: "",
  reviewDesignLead: "",
  reviewDesignLeadName: "",
  reviewDesignLeadAvatar: "",
  /**
   * Пользовательские кнопки на форме work item. Каждая запись создаёт свой Work Item
   * по заданным параметрам. Массив редактируется на странице настроек.
   * `customFields[]` — дополнительные поля создаваемой WI (select поля из списка
   * полей выбранного типа + input/select значения; удаляются по «×»).
   * @type {Array<{id:string,name:string,wiType:string,wiTypeIcon:{url:string,color:string},title:string,titlePrefix:string,titleFromParent:boolean,assignedTo:string,assignedToName:string,assignedToAvatar:string,description:string,tags:string[],links:Array<{relType:string,targetId:number,targetTitle:string,toParent:boolean}>,customFields:Array<{referenceName:string,name:string,type:string,value:string}>}>}
   */
  customReviewButtons: [],
};

export async function loadAdoConfig() {
  const stored = await chrome.storage.local.get(ADO_CONFIG_KEY);
  console.log('Storage get result:', stored);
  const partial = stored[ADO_CONFIG_KEY] ?? {};
  console.log('Partial config:', partial);
  const raw = { ...DEFAULT_ADO_CONFIG, ...partial };
  raw.customReviewButtons = Array.isArray(partial.customReviewButtons)
    ? partial.customReviewButtons
    : [];
  raw.apiVersion = '6.0-preview';
  raw.refreshIntervalMinutes = resolveRefreshIntervalMinutes(raw);

  // Поля сценария «Ревью» без UI — всегда берём из дефолтов (хардкод),
  // чтобы устаревшие значения из storage их не перекрывали.
  raw.reviewWorkItemType = DEFAULT_ADO_CONFIG.reviewWorkItemType;
  raw.reviewPlaceholderText = DEFAULT_ADO_CONFIG.reviewPlaceholderText;

  // Remove deprecated fields
  delete raw.repositoryId;
  delete raw.selectedGroupIds;
  delete raw.selectedGroupLabels;
  delete raw.iterationPath;
  delete raw.reviewTemplateTeam;
  delete raw.reviewTemplateId;

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

  if (!Number.isInteger(Number(config.refreshIntervalMinutes))
    || Number(config.refreshIntervalMinutes) < 1) {
    errors.push("Укажите период обновления в минутах целым числом не меньше 1.");
  }

  const queryId = String(config.workItemQueryId ?? "").trim();
  if (queryId && !isWorkItemQueryId(queryId)) {
    errors.push("Некорректный идентификатор Query.");
  }

  return errors;
}

/** GUID сохранённого Query Azure DevOps. */
export function isWorkItemQueryId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value ?? "").trim(),
  );
}

/**
 * Валидация настроек сценария «Создать задачу на ревью» (FR-006).
 * @param {typeof DEFAULT_ADO_CONFIG} config
 * @returns {string[]} список сообщений об ошибках
 */
export function validateReviewConfig(config) {
  const errors = [];

  if (!String(config?.reviewProject ?? "").trim()) {
    errors.push("Укажите проект для задач на ревью.");
  }

  if (!String(config?.reviewWorkItemType ?? "").trim()) {
    errors.push("Укажите тип задачи на ревью (например Review).");
  }

  const rawUrl = String(config?.reviewTemplateUrl ?? "").trim();
  if (!rawUrl) {
    errors.push("Укажите ссылку на шаблон задачи на ревью (содержит templateId и ownerId).");
  } else {
    const parsed = parseReviewTemplateUrl(rawUrl);
    if (!parsed) {
      errors.push("Не удалось извлечь templateId и ownerId из ссылки на шаблон. Убедитесь, что ссылка содержит параметры templateId и ownerId.");
    } else {
      if (!parsed.templateId) {
        errors.push("В ссылке на шаблон не найден параметр templateId (GUID шаблона).");
      } else if (!isTemplateIdGuid(parsed.templateId)) {
        errors.push("templateId из ссылки имеет некорректный формат GUID.");
      }
      if (!parsed.ownerId) {
        errors.push("В ссылке на шаблон не найден параметр ownerId (ID команды).");
      }
    }
  }

  const rawParent = String(config?.reviewParentId ?? "").trim();
  if (rawParent && parseReviewParentId(rawParent) === null) {
    errors.push("Номер родительской задачи должен быть положительным целым числом.");
  }

  return errors;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTemplateIdGuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value ?? "").trim(),
  );
}

/**
 * Извлекает templateId и ownerId из ссылки на страницу создания задачи на ревью.
 * Принимает полную URL или фрагмент с query-параметрами (например "templateId=...&ownerId=...").
 * @param {string} value
 * @returns {{ templateId: string, ownerId: string } | null}
 */
export function parseReviewTemplateUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    try {
      const normalized = raw.startsWith("?") ? raw : `?${raw.replace(/^\?/, "")}`;
      url = new URL(`https://template.resolve/${normalized}`);
    } catch {
      return null;
    }
  }

  const templateId = url.searchParams.get("templateId");
  const ownerId = url.searchParams.get("ownerId");

  if (!templateId && !ownerId) return null;

  return {
    templateId: (templateId ?? "").trim(),
    ownerId: (ownerId ?? "").trim(),
  };
}

/**
 * @param {unknown} value
 * @returns {number|null} положительное целое или null
 */
export function parseReviewParentId(value) {
  const raw = String(value ?? "").trim();

  if (!/^\d+$/.test(raw)) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * @param {unknown} value
 * @returns {number|null} положительное целое или null
 */
export function parseWorkItemId(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Разбирает список типов исходных задач для показа кнопки.
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseReviewDesignTypes(value) {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function resolveApiVersion(config) {
  const raw = config?.apiVersion ?? DEFAULT_ADO_CONFIG.apiVersion;
  return String(raw ?? "").trim() || DEFAULT_ADO_CONFIG.apiVersion;
}

/**
 * Проект, в котором создаются задачи на ревью.
 * Не зависит от `project` в основных настройках (список WI в popup).
 * @param {typeof DEFAULT_ADO_CONFIG} config
 * @returns {string}
 */
export function resolveReviewProject(config) {
  const raw = String(config?.reviewProject ?? "").trim();
  return raw || DEFAULT_ADO_CONFIG.reviewProject;
}

export function resolveRefreshIntervalMinutes(config) {
  const raw = Number(config?.refreshIntervalMinutes);

  if (Number.isInteger(raw) && raw >= 1) {
    return raw;
  }

  return DEFAULT_ADO_CONFIG.refreshIntervalMinutes;
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
