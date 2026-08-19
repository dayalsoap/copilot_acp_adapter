import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeAutopilotModeMessage, normalizeNativeMessage } from "../src/server.js";

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

test("autopilot commands with arguments remain native slash commands", () => {
  assert.equal(nativeAutopilotModeMessage({
    method: "session/prompt",
    params: { sessionId: "s1", prompt: "/autopilot off" },
  }), null);
});
