import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listConfiguredModels,
  modelDisplayName,
  parseNativeAcpModelsOutput,
  parseModelCatalog,
} from "../src/models.js";

test("empty model catalog parser returns only auto", () => {
  assert.deepEqual(parseModelCatalog(""), ["auto"]);
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

test("native ACP model parser reads filtered available models", () => {
  const output = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        models: {
          availableModels: [{ modelId: "auto" }, { modelId: "allowed-model" }],
        },
      },
    }),
  ].join("\n");

  assert.deepEqual(parseNativeAcpModelsOutput(output), [
    "auto",
    "allowed-model",
  ]);
});

test("explicit model catalog override bypasses native discovery", () => {
  assert.deepEqual(
    listConfiguredModels({
      copilotModelsOverride: true,
      copilotModels: ["auto", "override-model"],
      copilotCommand: "/does/not/exist",
    }),
    ["auto", "override-model"],
  );
});

test("native discovery failure falls back to configured minimal catalog", () => {
  assert.deepEqual(
    listConfiguredModels({
      copilotModelsOverride: false,
      copilotModels: ["auto"],
      copilotCommand: "/does/not/exist",
      cwd: process.cwd(),
      modelDiscoveryTimeoutMs: 1,
    }),
    ["auto"],
  );
});
