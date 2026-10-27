import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enhanceNativePromptResponse,
  nativeAutopilotModeMessage,
  nativeConfigModeMessage,
  normalizeNativeMessage,
  rewriteChangelogSummary,
} from "../src/server.js";
import { CopilotAcpAdapter } from "../src/adapter.js";

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

test("changelog summarize is forwarded to native as a prompt, and fetch failures are answered locally", async () => {
  const sent = [];
  const connection = { send(message) { sent.push(message); } };
  const updates = [];
  let markdown = "# Changelog\n\n## 1.0.0\n\nFast.\n";
  const adapter = new CopilotAcpAdapter({
    config: { cwd: "/tmp" },
    runner: {},
    fetchImpl: async () => (markdown ? { ok: true, text: async () => markdown } : { ok: false, status: 503 }),
    notify(method, params) { updates.push(params); },
  });
  await adapter.adoptNativeSession({}, { sessionId: "s1", models: { currentModelId: "auto", availableModels: [] } });

  const plain = { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s1", prompt: "hello" } };
  assert.equal(await rewriteChangelogSummary(adapter, connection, plain), plain);

  const rewritten = await rewriteChangelogSummary(adapter, connection,
    { jsonrpc: "2.0", id: 2, method: "prompt", params: { sessionId: "s1", text: "/changelog summarize" } });
  assert.equal(rewritten.method, "session/prompt");
  assert.equal(rewritten.params.text, undefined);
  assert.match(rewritten.params.prompt[0].text, /Summarize these official GitHub Copilot CLI release notes[\s\S]*Fast\./);
  assert.equal(sent.length, 0);

  markdown = "";
  adapter.changelogPromise = null;
  const failed = await rewriteChangelogSummary(adapter, connection,
    { jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s1", prompt: "/changelog summarize" } });
  assert.equal(failed, null);
  assert.equal(sent[0].id, 3);
  assert.equal(sent[0].result.stopReason, "error");
  assert.match(updates.at(-1).update.content.text, /Could not load the Copilot CLI changelog: Changelog request failed with HTTP 503/);
});
