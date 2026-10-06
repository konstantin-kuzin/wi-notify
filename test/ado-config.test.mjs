import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCustomTemplateUrl } from "../ado-config.mjs";

test("parseCustomTemplateUrl: возвращает null для пустого значения", () => {
  assert.equal(parseCustomTemplateUrl(""), null);
  assert.equal(parseCustomTemplateUrl(null), null);
  assert.equal(parseCustomTemplateUrl("   "), null);
});

test("parseCustomTemplateUrl: извлекает только templateId и ownerId из query-only строки", () => {
  const result = parseCustomTemplateUrl("?templateId=abc-123&ownerId=team-456");
  assert.equal(result?.templateId, "abc-123");
  assert.equal(result?.ownerId, "team-456");
  assert.equal(result?.project, "");
  assert.equal(result?.wiType, "");
});

test("parseCustomTemplateUrl: извлекает project и wiType из полного URL", () => {
  const url = "https://hqrndtfs.avp.ru/tfs/Monorepo/_workitems/create/Task?templateId=abc-123&ownerId=team-456";
  const result = parseCustomTemplateUrl(url);
  assert.equal(result?.templateId, "abc-123");
  assert.equal(result?.ownerId, "team-456");
  assert.equal(result?.project, "Monorepo");
  assert.equal(result?.wiType, "Task");
});

test("parseCustomTemplateUrl: извлекает project и wiType для Bug", () => {
  const url = "https://hqrndtfs.avp.ru/tfs/DefaultCollection/SomeProject/_workitems/create/Bug?templateId=xyz&ownerId=own";
  const result = parseCustomTemplateUrl(url);
  assert.equal(result?.templateId, "xyz");
  assert.equal(result?.ownerId, "own");
  assert.equal(result?.project, "SomeProject");
  assert.equal(result?.wiType, "Bug");
});

test("parseCustomTemplateUrl: для URL без _workitems возвращает только templateId и ownerId", () => {
  const url = "https://hqrndtfs.avp.ru/tfs/SomeProject?_wrong_=1&templateId=abc&ownerId=own";
  const result = parseCustomTemplateUrl(url);
  assert.equal(result?.templateId, "abc");
  assert.equal(result?.ownerId, "own");
  assert.equal(result?.project, ""); // _workitems нет в пути
  assert.equal(result?.wiType, "");
});

test("parseCustomTemplateUrl: корректно обрабатывает URL с пустым templateId", () => {
  const result = parseCustomTemplateUrl("?templateId=&ownerId=team-456");
  assert.equal(result, null);
});

test("parseCustomTemplateUrl: GUID templateId распознаётся", () => {
  const url = "https://hqrndtfs.avp.ru/tfs/Monorepo/_workitems/create/Epic?templateId=12345678-1234-1234-1234-123456789abc&ownerId=own";
  const result = parseCustomTemplateUrl(url);
  assert.equal(result?.templateId, "12345678-1234-1234-1234-123456789abc");
  assert.equal(result?.project, "Monorepo");
  assert.equal(result?.wiType, "Epic");
});
