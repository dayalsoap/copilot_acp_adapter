import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MODEL_IDS, modelDisplayName, parseModelCatalog } from "../src/models.js";

test("default model catalog includes Copilot CLI models", () => {
  assert.equal(DEFAULT_MODEL_IDS.includes("auto"), true);
  assert.equal(DEFAULT_MODEL_IDS.includes("claude-sonnet-5"), true);
  assert.equal(DEFAULT_MODEL_IDS.includes("gpt-5.4"), true);
  assert.equal(DEFAULT_MODEL_IDS.includes("gemini-3.5-flash"), true);
});

test("model catalog parser supports comma-separated and JSON overrides", () => {
  assert.deepEqual(parseModelCatalog("gpt-5.4,claude-sonnet-5"), [
    "auto",
    "gpt-5.4",
    "claude-sonnet-5",
  ]);
  assert.deepEqual(parseModelCatalog('["auto","kimi-k2.7-code"]'), [
    "auto",
    "kimi-k2.7-code",
  ]);
});

test("model display names are human readable", () => {
  assert.equal(modelDisplayName("auto"), "Auto");
  assert.equal(modelDisplayName("gpt-5.4-mini"), "GPT 5 4 Mini");
  assert.equal(modelDisplayName("claude-sonnet-5"), "Claude Sonnet 5");
});
