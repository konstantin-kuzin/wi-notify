import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCustomTitle,
  tagsToFieldValue,
  descriptionToHtml,
  buildCustomWorkItemFields,
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
