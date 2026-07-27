import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listConfiguredModels,
  modelDisplayName,
  parseCopilotConfigModels,
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

test("native ACP model parser prefers settable config option models", () => {
  const output = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        models: {
          availableModels: [{ modelId: "auto" }, { modelId: "display-only" }],
        },
        configOptions: [
          {
            id: "model",
            category: "model",
            type: "select",
            currentValue: "allowed-model",
            options: [
              { value: "allowed-model" },
              {
                group: "More",
                options: [{ value: "other-allowed-model" }],
              },
            ],
          },
        ],
      },
    }),
  ].join("\n");

  assert.deepEqual(parseNativeAcpModelsOutput(output), [
    "auto",
    "allowed-model",
    "other-allowed-model",
  ]);
});

test("Copilot config help parser reads model choices", () => {
  const output = [
    "Configuration Settings:",
    "",
    "  `model`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.",
    '    - "claude-sonnet-5"',
    '    - "gpt-5.4"',
    '    - "gemini-3.5-flash"',
    "",
    "  `contextTier`: context window tier for tiered-pricing models.",
  ].join("\n");

  assert.deepEqual(parseCopilotConfigModels(output), [
    "auto",
    "claude-sonnet-5",
    "gpt-5.4",
    "gemini-3.5-flash",
  ]);
});

test("explicit model catalog override bypasses native discovery", async () => {
  assert.deepEqual(
    await listConfiguredModels({
      copilotModelsOverride: true,
      copilotModels: ["auto", "override-model"],
      copilotCommand: "/does/not/exist",
    }),
    ["auto", "override-model"],
  );
});

test("native discovery failure falls back to configured minimal catalog", async () => {
  assert.deepEqual(
    await listConfiguredModels({
      copilotModelsOverride: false,
      copilotModels: ["auto"],
      copilotCommand: "/does/not/exist",
      cwd: process.cwd(),
      modelDiscoveryTimeoutMs: 1,
    }),
    ["auto"],
  );
});
