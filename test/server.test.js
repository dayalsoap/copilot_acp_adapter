import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enhanceNativePromptResponse,
  nativeAutopilotModeMessage,
  nativeConfigModeMessage,
  normalizeNativeMessage,
} from "../src/server.js";

test("completed prompt response invokes the native subagent journal hook once", async () => {
  const calls = []; const adapter = { async reportNativeSubagentDispatch(sessionId) { calls.push(sessionId); } };
  const response = { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } };
  assert.deepEqual(await enhanceNativePromptResponse(adapter, { method: "session/prompt", params: { sessionId: "s1" } }, response), response);
  assert.deepEqual(calls, ["s1"]);
  await enhanceNativePromptResponse(adapter, { method: "session/prompt", params: { sessionId: "s2" } }, { ...response, error: { code: -1 } });
  await enhanceNativePromptResponse(adapter, { method: "session/update", params: { sessionId: "s3" } }, response);
  assert.deepEqual(calls, ["s1"]);
});

test("native prompt proxy normalizes string shorthand to ACP content blocks", () => {
  assert.deepEqual(
    normalizeNativeMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "prompt",
      params: {
        sessionId: "s1",
        prompt: "hello",
      },
    }),
    {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: {
        sessionId: "s1",
        prompt: [{ type: "text", text: "hello" }],
      },
    },
  );
});

test("bare /autopilot uses the native ACP mode-change method", () => {
  assert.deepEqual(
    nativeAutopilotModeMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId: "s1",
        prompt: [{ type: "text", text: "  /autopilot  " }],
      },
    }, "copilot#autopilot"),
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/set_mode",
      params: {
        sessionId: "s1",
        modeId: "copilot#autopilot",
      },
    },
  );
});

test("agent-shell mode config requests use the native ACP mode-change method", () => {
  assert.deepEqual(
    nativeConfigModeMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_config_option",
      params: {
        sessionId: "s1",
        configId: "mode",
        value: "autopilot",
      },
    }, "copilot#autopilot"),
    {
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_mode",
      params: {
        sessionId: "s1",
        modeId: "copilot#autopilot",
      },
    },
  );
});

test("autopilot commands with arguments remain native slash commands", () => {
  assert.equal(nativeAutopilotModeMessage({
    method: "session/prompt",
    params: { sessionId: "s1", prompt: "/autopilot off" },
  }), null);
});
