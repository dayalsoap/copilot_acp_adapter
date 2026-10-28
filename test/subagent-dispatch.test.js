import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CopilotAcpAdapter } from "../src/adapter.js";

function makeAdapter(root, notifications) {
  return new CopilotAcpAdapter({
    config: { cwd: "/tmp", copilotSessionStatePath: root },
    runner: {}, notify(method, params) { notifications.push({ method, params }); },
  });
}

test("native subagent reports distinguish request from recorded dispatch and deduplicate turns", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "copilot-dispatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "session1"));
  writeFileSync(join(root, "session1", "events.jsonl"), JSON.stringify({
    type: "subagent.completed", agentId: "child", data: {
      toolCallId: "call1", agentName: "test-diagnostician", model: "gpt-5.6-luna",
      firstDispatchedModel: "mai-code-1.1-flash", explicitModelOverride: "gpt-5.6-luna",
    },
  }));
  const notifications = [];
  const adapter = makeAdapter(root, notifications);
  await adapter.adoptNativeSession({}, { sessionId: "session1" });
  const original = { jsonrpc: "2.0", method: "session/update", params: { sessionId: "session1", update: {
    sessionUpdate: "tool_call", toolCallId: "call1", rawInput: { agent_type: "test-diagnostician", model: "gpt-5.6-luna" },
  } } };
  const enhanced = adapter.enhanceNativeMessages(original);
  assert.deepEqual(enhanced, [original]);
  assert.strictEqual(enhanced[0], original, "original native message is retained by identity");
  await adapter.reportNativeSubagentDispatch("session1");
  const report = notifications.find((item) => item.params.update._meta?.activity === "subagent-dispatch-report");
  assert.match(report.params.update.content.text, /Recorded first dispatched model: `mai-code-1\.1-flash`/);
  assert.equal(report.params.update._meta.mismatch, true);
  await adapter.reportNativeSubagentDispatch("session1");
  assert.equal(notifications.filter((item) => item.params.update._meta?.activity === "subagent-dispatch-report").length, 1);
});

test("reports each tracked agent, retries for all completions, and retains a later start", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "copilot-dispatch-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "session3")); const journal = join(root, "session3", "events.jsonl"); writeFileSync(journal, "");
  const notifications = []; const adapter = makeAdapter(root, notifications); await adapter.adoptNativeSession({}, { sessionId: "session3" });
  for (const [id, name] of [["one", "first"], ["two", "second"]]) adapter.enhanceNativeMessages({ method: "session/update", params: { sessionId: "session3", update: { sessionUpdate: "tool_call", toolCallId: id, rawInput: { agent_type: name, model: "luna" } } } });
  setTimeout(() => writeFileSync(journal, ["one", "two"].map((id) => JSON.stringify({ type: "subagent.completed", data: { toolCallId: id, agentName: id === "one" ? "first" : "second", model: "luna", firstDispatchedModel: "luna", explicitModelOverride: "luna" } })).join("\n")), 20);
  setTimeout(() => adapter.enhanceNativeMessages({ method: "session/update", params: { sessionId: "session3", update: { sessionUpdate: "tool_call", toolCallId: "later", rawInput: { agent_type: "later", model: "luna" } } } }), 20);
  await adapter.reportNativeSubagentDispatch("session3");
  assert.equal(notifications.filter((item) => item.params.update._meta?.activity === "subagent-dispatch-report").length, 2);
  await adapter.reportNativeSubagentDispatch("session3");
  assert.equal(notifications.filter((item) => item.params.update._meta?.toolCallId === "later").length, 1);
});

test("native subagent completion reports unknown rather than claiming configured/requested dispatch", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "copilot-dispatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "session2"));
  writeFileSync(join(root, "session2", "events.jsonl"), "bad partial json");
  const notifications = [];
  const adapter = makeAdapter(root, notifications);
  await adapter.adoptNativeSession({}, { sessionId: "session2" });
  adapter.enhanceNativeMessages({ method: "session/update", params: { sessionId: "session2", update: {
    sessionUpdate: "tool_call", toolCallId: "call2", rawInput: { agent_type: "test-diagnostician", model: "gpt-5.6-luna" },
  } } });
  await adapter.reportNativeSubagentDispatch("session2");
  const report = notifications.find((item) => item.params.update._meta?.activity === "subagent-dispatch-report");
  assert.equal(report.params.update._meta.firstDispatchedModel, "unknown");
  assert.equal(report.params.update._meta.evidence, "unavailable");
});

test("a failed subagent still reports its recorded dispatch model", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "copilot-dispatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "session4"));
  writeFileSync(join(root, "session4", "events.jsonl"), JSON.stringify({
    type: "subagent.failed", agentId: "child", data: {
      toolCallId: "call4", agentName: "test-diagnostician", error: "Agent completed but produced no response.",
      model: "gpt-5.6-luna", firstDispatchedModel: "gpt-5.6-luna", explicitModelOverride: "gpt-5.6-luna",
    },
  }));
  const notifications = [];
  const adapter = makeAdapter(root, notifications);
  await adapter.adoptNativeSession({}, { sessionId: "session4" });
  adapter.enhanceNativeMessages({ method: "session/update", params: { sessionId: "session4", update: {
    sessionUpdate: "tool_call", toolCallId: "call4", rawInput: { agent_type: "test-diagnostician", model: "gpt-5.6-luna" },
  } } });
  await adapter.reportNativeSubagentDispatch("session4");
  const report = notifications.find((item) => item.params.update._meta?.activity === "subagent-dispatch-report").params.update;
  assert.match(report.content.text, /model report \(subagent failed\)\. Requested model: `gpt-5\.6-luna`\. Recorded first dispatched model: `gpt-5\.6-luna`\./);
  assert.equal(report._meta.evidence, "subagent.failed");
  assert.equal(report._meta.firstDispatchedModel, "gpt-5.6-luna");
  assert.equal(report._meta.explicitModelOverride, "gpt-5.6-luna");
  assert.equal(report._meta.mismatch, false);
});
