import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCustomTitle,
  tagsToFieldValue,
  descriptionToHtml,
  buildCustomWorkItemFields,
  coerceCustomFieldValue,
  isComputedWorkItemField,
  applyCustomFields,
} from "../custom-wi-fields.mjs";

test("resolveCustomTitle: своё название, если чекбокс выключен", () => {
  assert.equal(
    resolveCustomTitle({ title: "Моя задача", titleFromParent: false }, "Исходная"),
    "Моя задача",
  );
});

test("resolveCustomTitle: из родителя, если чекбокс включён", () => {
  assert.equal(
    resolveCustomTitle({ title: "Моя задача", titleFromParent: true }, "Исходная"),
    "Исходная",
  );
});

test("resolveCustomTitle: префикс добавляется перед названием из родителя", () => {
  assert.equal(
    resolveCustomTitle(
      { title: "Моя задача", titleFromParent: true, titlePrefix: "[UX]" },
      "Исходная",
    ),
    "[UX]Исходная",
  );
});

test("resolveCustomTitle: пустой префикс не меняет название из родителя", () => {
  assert.equal(
    resolveCustomTitle(
      { title: "Моя задача", titleFromParent: true, titlePrefix: "  " },
      "Исходная",
    ),
    "Исходная",
  );
});

test("resolveCustomTitle: префикс игнорируется, если чекбокс выключен", () => {
  assert.equal(
    resolveCustomTitle(
      { title: "Моя задача", titleFromParent: false, titlePrefix: "[UX]" },
      "Исходная",
    ),
    "Моя задача",
  );
});

test("tagsToFieldValue: объединяет через '; ' и чистит пустые", () => {
  assert.equal(tagsToFieldValue(["a", " ", "b"]), "a; b");
  assert.equal(tagsToFieldValue([]), "");
});

test("descriptionToHtml: экранирует и переводит строки", () => {
  assert.equal(descriptionToHtml("a<b>\nc"), "a&lt;b&gt;<br>c");
  assert.equal(descriptionToHtml("  "), "");
});

test("buildCustomWorkItemFields: копирует area/iteration и заполняет непустые поля", () => {
  const fields = buildCustomWorkItemFields(
    {
      title: "T", titleFromParent: false, assignedTo: "Имя <D\\a>",
      tags: ["x"], description: "d",
    },
    { title: "Src", areaPath: "P\\Area", iterationPath: "P\\Iter" },
  );
  assert.equal(fields["System.Title"], "T");
  assert.equal(fields["System.AreaPath"], "P\\Area");
  assert.equal(fields["System.IterationPath"], "P\\Iter");
  assert.equal(fields["System.AssignedTo"], "Имя <D\\a>");
  assert.equal(fields["System.Tags"], "x");
  assert.equal(fields["System.Description"], "d");
});

test("buildCustomWorkItemFields: пропускает пустые опциональные поля", () => {
  const fields = buildCustomWorkItemFields(
    { title: "T", titleFromParent: false, assignedTo: "", tags: [], description: "" },
    { title: "Src", areaPath: "", iterationPath: "" },
  );
  assert.ok(!("System.AssignedTo" in fields));
  assert.ok(!("System.Tags" in fields));
  assert.ok(!("System.Description" in fields));
  assert.ok(!("System.AreaPath" in fields));
});

test("buildCustomWorkItemFields: descriptionFromParent копирует описание исходной задачи как есть", () => {
  const fields = buildCustomWorkItemFields(
    { title: "T", titleFromParent: false, descriptionFromParent: true, description: "игнор" },
    { title: "Src", description: "<div>Исходное <b>HTML</b></div>" },
  );
  assert.equal(fields["System.Description"], "<div>Исходное <b>HTML</b></div>");
});

test("buildCustomWorkItemFields: descriptionFromParent без описания у источника — поле не ставится", () => {
  const fields = buildCustomWorkItemFields(
    { title: "T", titleFromParent: false, descriptionFromParent: true, description: "игнор" },
    { title: "Src", description: "" },
  );
  assert.ok(!("System.Description" in fields));
});

test("coerceCustomFieldValue: пустое значение → null", () => {
  assert.equal(coerceCustomFieldValue("System.String", ""), null);
  assert.equal(coerceCustomFieldValue("System.String", "   "), null);
  assert.equal(coerceCustomFieldValue("System.String", null), null);
});

test("coerceCustomFieldValue: числа приводятся к number (в т.ч. с запятой)", () => {
  assert.equal(coerceCustomFieldValue("System.Double", "3.5"), 3.5);
  assert.equal(coerceCustomFieldValue("System.Double", "3,5"), 3.5);
  assert.equal(coerceCustomFieldValue("System.Integer", "42"), 42);
  // Нечисловое значение остаётся строкой
  assert.equal(coerceCustomFieldValue("System.Double", "abc"), "abc");
});

test("coerceCustomFieldValue: булевы → boolean", () => {
  assert.equal(coerceCustomFieldValue("System.Boolean", "true"), true);
  assert.equal(coerceCustomFieldValue("System.Boolean", "false"), false);
  assert.equal(coerceCustomFieldValue("System.Boolean", "1"), true);
  assert.equal(coerceCustomFieldValue("System.Boolean", "да"), true);
  assert.equal(coerceCustomFieldValue("System.Boolean", "no"), false);
});

test("coerceCustomFieldValue: DateTime → ISO-строка UTC", () => {
  // datetime-local отдаёт строку без зоны; она интерпретируется как локальное время.
  const iso = coerceCustomFieldValue("System.DateTime", "2026-01-02T12:30");
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(iso), iso);
  // Уже ISO-значение сохраняет момент времени
  assert.equal(coerceCustomFieldValue("System.DateTime", "2026-01-02T12:30:00Z"), "2026-01-02T12:30:00.000Z");
  // Нераспарсиваемое — как есть
  assert.equal(coerceCustomFieldValue("System.DateTime", "мусор"), "мусор");
});

test("coerceCustomFieldValue: строки и identity остаются строками", () => {
  assert.equal(coerceCustomFieldValue("System.String", "Foo <D\\u>"), "Foo <D\\u>");
  assert.equal(coerceCustomFieldValue("System.Identity", "a@b"), "a@b");
  assert.equal(coerceCustomFieldValue("", "plain"), "plain");
});

test("isComputedWorkItemField: служебные поля распознаются, обычные — нет", () => {
  assert.equal(isComputedWorkItemField("System.Id"), true);
  assert.equal(isComputedWorkItemField("System.Rev"), true);
  assert.equal(isComputedWorkItemField("System.TeamProject"), true);
  assert.equal(isComputedWorkItemField(" System.Id "), true);
  assert.equal(isComputedWorkItemField("System.Title"), false);
  assert.equal(isComputedWorkItemField("Custom.Field"), false);
  assert.equal(isComputedWorkItemField(""), false);
  assert.equal(isComputedWorkItemField(null), false);
});

test("applyCustomFields: добавляет поля и приводит значения по типу", () => {
  const fields = {};
  applyCustomFields(
    { customFields: [
      { referenceName: "Custom.Priority", name: "Priority", type: "System.Double", value: "2" },
      { referenceName: "Custom.Flag", name: "Flag", type: "System.Boolean", value: "true" },
      { referenceName: "Custom.Note", name: "Note", type: "System.String", value: "привет" },
    ] },
    fields,
  );
  assert.equal(fields["Custom.Priority"], 2);
  assert.equal(fields["Custom.Flag"], true);
  assert.equal(fields["Custom.Note"], "привет");
});

test("applyCustomFields: не перетирает базовые поля и пропускает пустые/без referenceName", () => {
  const fields = { "System.Title": "База", "System.Tags": "x" };
  applyCustomFields(
    { customFields: [
      { referenceName: "System.Title", name: "Title", type: "System.String", value: "Чужое" },
      { referenceName: "System.Tags", name: "Tags", type: "System.String", value: "y" },
      { referenceName: "", name: "Нет ref", type: "System.String", value: "z" },
      { referenceName: "Custom.Empty", name: "Пусто", type: "System.String", value: "" },
      { referenceName: "Custom.NoValue", name: "Без значения", type: "System.String" },
    ] },
    fields,
  );
  assert.equal(fields["System.Title"], "База");
  assert.equal(fields["System.Tags"], "x");
  assert.ok(!("Custom.Empty" in fields));
  assert.ok(!("Custom.NoValue" in fields));
});

test("applyCustomFields: без customFields ничего не делает", () => {
  const fields = { "System.Title": "T" };
  applyCustomFields({}, fields);
  applyCustomFields({ customFields: "не массив" }, fields);
  assert.deepEqual(fields, { "System.Title": "T" });
});

test("buildCustomWorkItemFields: прокидывает customFields кнопки", () => {
  const fields = buildCustomWorkItemFields(
    {
      title: "T", titleFromParent: false,
      customFields: [
        { referenceName: "Custom.Size", name: "Size", type: "System.Integer", value: "3" },
      ],
    },
    { title: "Src", areaPath: "", iterationPath: "" },
  );
  assert.equal(fields["Custom.Size"], 3);
  assert.equal(fields["System.Title"], "T");
});
