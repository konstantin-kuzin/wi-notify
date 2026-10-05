// Чистые хелперы сборки полей кастомной задачи. Без chrome/DOM — тестируются node:test.

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** @param {{title?:string,titleFromParent?:boolean,titlePrefix?:string}} buttonConfig */
export function resolveCustomTitle(buttonConfig, sourceTitle) {
  if (buttonConfig?.titleFromParent) {
    const source = String(sourceTitle ?? "").trim();
    const prefix = String(buttonConfig?.titlePrefix ?? "").trim();
    if (prefix) {
      return `${prefix}${source}`;
    }
    return source;
  }
  return String(buttonConfig?.title ?? "").trim();
}

/** @param {string[]} tags */
export function tagsToFieldValue(tags) {
  const list = Array.isArray(tags) ? tags : [];
  return list.map((t) => String(t ?? "").trim()).filter(Boolean).join("; ");
}

/** @param {string} text */
export function descriptionToHtml(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return "";
  }
  return escapeHtml(raw).replace(/\r\n/g, "\n").replaceAll("\n", "<br>");
}

/**
 * Вычисляемые/служебные поля, которые нельзя (или бессмысленно) задавать при
 * создании WI через PATCH. Скрываются из списка полей в настройках.
 */
const COMPUTED_FIELD_REFERENCE_NAMES = new Set([
  "System.Id",
  "System.Rev",
  "System.RevisedDate",
  "System.ChangedDate",
  "System.CreatedDate",
  "System.AuthorizedDate",
  "System.AuthorizedAs",
  "System.Watermark",
  "System.RowVersion",
  "System.Timestamp",
  "System.AreaId",
  "System.IterationId",
  "System.ExternalLinkCount",
  "System.HyperLinkCount",
  "System.RelatedLinkCount",
  "System.AttachedFileCount",
  "System.WorkItemType",
  "System.TeamProject",
]);

/** @param {string} referenceName */
export function isComputedWorkItemField(referenceName) {
  return COMPUTED_FIELD_REFERENCE_NAMES.has(String(referenceName ?? "").trim());
}

/**
 * Приводит значение дополнительного поля к типу, который принимает ADO PATCH.
 * Числа → number, булевы → boolean, даты → ISO-строка; пустое → null (поле пропускается).
 * @param {string} type тип поля из API (System.Double, System.DateTime, …)
 * @param {unknown} value
 * @returns {string|number|boolean|null}
 */
export function coerceCustomFieldValue(type, value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  const t = String(type ?? "");
  if (/Double|Integer|Number/i.test(t)) {
    const num = Number(raw.replace(",", "."));
    return Number.isFinite(num) ? num : raw;
  }
  if (/Boolean/i.test(t)) {
    return /^(true|1|да|yes)$/i.test(raw);
  }
  if (/date/i.test(t)) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? raw : date.toISOString();
  }
  return raw;
}

/**
 * Дополнительные поля кнопки → значения для PATCH. Базовые поля кнопки
 * (title, assignee и т.д.) имеют приоритет — доп. поле их не перетирает.
 * @param {object} buttonConfig
 * @param {Record<string, string|number|boolean>} fields уже собранные поля
 */
export function applyCustomFields(buttonConfig, fields) {
  const customFields = Array.isArray(buttonConfig?.customFields) ? buttonConfig.customFields : [];
  for (const custom of customFields) {
    const referenceName = String(custom?.referenceName ?? "").trim();
    if (!referenceName || referenceName in fields) {
      continue;
    }
    const value = coerceCustomFieldValue(custom?.type, custom?.value);
    if (value !== null && value !== "") {
      fields[referenceName] = value;
    }
  }
}

/**
 * @param {object} buttonConfig
 * @param {{title:string,areaPath:string,iterationPath:string}} source
 * @returns {Record<string,string|number|boolean>}
 */
export function buildCustomWorkItemFields(buttonConfig, source) {
  const fields = {};
  fields["System.Title"] = resolveCustomTitle(buttonConfig, source?.title);

  const area = String(source?.areaPath ?? "").trim();
  if (area) {
    fields["System.AreaPath"] = area;
  }
  const iteration = String(source?.iterationPath ?? "").trim();
  if (iteration) {
    fields["System.IterationPath"] = iteration;
  }
  const assignedTo = String(buttonConfig?.assignedTo ?? "").trim();
  if (assignedTo) {
    fields["System.AssignedTo"] = assignedTo;
  }
  const tags = tagsToFieldValue(buttonConfig?.tags);
  if (tags) {
    fields["System.Tags"] = tags;
  }
  if (buttonConfig?.descriptionFromParent) {
    // Копируем описание исходной задачи как есть (это уже HTML из System.Description).
    const sourceDescription = String(source?.description ?? "").trim();
    if (sourceDescription) {
      fields["System.Description"] = sourceDescription;
    }
  } else {
    const description = descriptionToHtml(buttonConfig?.description);
    if (description) {
      fields["System.Description"] = description;
    }
  }
  applyCustomFields(buttonConfig, fields);
  return fields;
}
