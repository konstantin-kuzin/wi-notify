// Чистые хелперы сборки полей кастомной задачи. Без chrome/DOM — тестируются node:test.

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** @param {{title?:string,titleFromParent?:boolean}} buttonConfig */
export function resolveCustomTitle(buttonConfig, sourceTitle) {
  if (buttonConfig?.titleFromParent) {
    return String(sourceTitle ?? "").trim();
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
 * @param {object} buttonConfig
 * @param {{title:string,areaPath:string,iterationPath:string}} source
 * @returns {Record<string,string>}
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
  return fields;
}
