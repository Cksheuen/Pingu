import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupModelInfo, MODEL_CATALOG } from "../src/translate/models";

test("MODEL_CATALOG ids are unique", () => {
  const ids = MODEL_CATALOG.map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length, "model ids must be unique");
});

test("every catalog entry has complete fields", () => {
  for (const model of MODEL_CATALOG) {
    assert.ok(typeof model.id === "string" && model.id !== "", "id must be a non-empty string");
    assert.ok(typeof model.display_name === "string" && model.display_name !== "", "display_name missing");
    assert.ok(Number.isInteger(model.context_length) && model.context_length > 0, "context_length invalid");
    assert.ok(
      Number.isInteger(model.max_completion_tokens) && model.max_completion_tokens > 0,
      "max_completion_tokens invalid"
    );
  }
});

test("lookupModelInfo finds known models and misses unknown ones", () => {
  const pro = lookupModelInfo("gemini-2.5-pro");
  assert.ok(pro);
  assert.equal(pro?.id, "gemini-2.5-pro");
  assert.equal(lookupModelInfo("does-not-exist"), undefined);
  assert.equal(lookupModelInfo(undefined), undefined);
});
