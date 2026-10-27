import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CopilotAcpAdapter } from "../src/adapter.js";
import { mentionedModels, readModelJournal, snapshotModelJournal } from "../src/model-reports.js";
import { enhanceNativePromptResponse } from "../src/server.js";

async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "copilot-model-report-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "session"));
  const journal = join(root, "session", "events.jsonl");
  writeFileSync(journal, `${JSON.stringify({ type: "model.call_start", data: { model: "old-history-model" } })}\n`);
  const updates = [];
  const adapter = new CopilotAcpAdapter({
    config: { cwd: root, copilotSessionStatePath: root,
      copilotModelsOverride: true, copilotModels: ["gpt-5.6-terra", "gpt-5.6-luna"], copilotModel: "gpt-5.6-terra", ...options.config },
    runner: options.runner || {},
    notify(method, params) { updates.push({ method, params }); },
  });
  await adapter.adoptNativeSession({ cwd: root }, { sessionId: "session", configOptions: [
    { id: "model", category: "model", currentValue: "gpt-5.6-terra", options: [{ value: "gpt-5.6-terra", name: "Terra" }, { value: "gpt-5.6-luna", name: "Luna" }] },
    { id: "agent", currentValue: "actual-selected-agent", options: [] },
  ] });
  const append = (events) => appendFileSync(journal, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const report = () => updates.filter((m) => m.params.update._meta?.activity === "model-request-report").at(-1)?.params.update;
  return { root, journal, adapter, append, report, updates };
}

test("model mentions trigger reporting without treating the mention as routing evidence", () => {
  assert.deepEqual(mentionedModels("run tests with gpt-5.6-luna and claude-opus-5.5"), ["gpt-5.6-luna", "claude-opus-5.5"]);
  assert.deepEqual(mentionedModels("use GPT 5.6 Luna for tests", ["gpt-5.6-luna"]), ["gpt-5.6-luna"]);
  assert.deepEqual(mentionedModels("use my-custom-model for tests", ["my-custom-model"]), ["my-custom-model"]);
  assert.deepEqual(mentionedModels("test-runner please run tests"), []);
  assert.deepEqual(mentionedModels("/model gpt-5.6-luna"), []);
});

test("direct skill execution reports current-turn model calls instead of the user's requested model", async (t) => {
  const f = await fixture(t);
  const prompt = "can you run the tests with gpt-5.6-luna with the test runner skill";
  const context = f.adapter.beginModelReport("session", prompt);
  f.adapter.enhanceNativeMessages({ method: "session/update", params: { sessionId: "session", update: {
    sessionUpdate: "tool_call", toolCallId: "skill", toolName: "skill", rawInput: { skill: "test-runner" },
  } } });
  f.append([
    { type: "model.call_start", data: { model: "gpt-5.6-terra" } },
    { type: "assistant.message", data: { model: "gpt-5.6-luna", content: "I used Luna" } },
    { type: "model.call_start", agentId: "child", data: { model: "child-model" } },
    { type: "assistant.usage", data: { model: "another-child", parentToolCallId: "task" } },
    { type: "model.call_start", data: { model: "auto" } },
  ]);
  const response = { result: { stopReason: "end_turn" } };
  assert.equal(await enhanceNativePromptResponse(f.adapter, { method: "session/prompt", params: { sessionId: "session" } }, response, context), response);
  const report = f.report();
  assert.equal(report.sessionUpdate, "agent_message_chunk", "the report is visible output, not a collapsed thought");
  assert.deepEqual(report._meta.recordedModels, ["gpt-5.6-terra"]);
  assert.equal(report._meta.requestedSessionModel, "gpt-5.6-terra");
  assert.equal(report._meta.sessionAgent, "actual-selected-agent");
  assert.deepEqual(report._meta.skills, ["test-runner"]);
  assert.match(report.content.text, /No subagent delegation observed/);
  assert.doesNotMatch(report.content.text, /old-history-model|child-model/);
  await f.adapter.finishModelReport(context, response);
  assert.equal(f.updates.filter((m) => m.params.update._meta?.activity === "model-request-report").length, 1);
});

test("delegation reports the completed agent and first dispatch even when both differ from the request", async (t) => {
  const f = await fixture(t);
  const context = f.adapter.beginModelReport("session", "run tests with gpt-5.6-luna");
  f.adapter.enhanceNativeMessages({ method: "session/update", params: { sessionId: "session", update: {
    sessionUpdate: "tool_call", toolCallId: "task", toolName: "task", rawInput: { agent_type: "requested-runner", model: "gpt-5.6-luna" },
  } } });
  f.append([{ type: "subagent.completed", agentId: "child", data: {
    toolCallId: "task", agentName: "different-runner", model: "gpt-5.6-luna", firstDispatchedModel: "mai-code-1.1-flash",
  } }]);
  await f.adapter.finishModelReport(context);
  assert.match(f.report().content.text, /Subagent recorded by Copilot: `different-runner`/);
  assert.match(f.report().content.text, /Recorded first dispatched subagent model: `mai-code-1\.1-flash`/);
  assert.equal(f.report()._meta.delegations[0].requestedAgent, "requested-runner");
});

test("unavailable evidence reports the actual request sent to Copilot and never echoes the desired model as used", async (t) => {
  const f = await fixture(t);
  const context = f.adapter.beginModelReport("session", "run tests with gpt-5.6-luna");
  f.adapter.enhanceNativeMessages({ method: "session/update", params: { sessionId: "session", update: {
    sessionUpdate: "tool_call", toolCallId: "task", toolName: "task", rawInput: { agent_type: "different-requested-agent", model: "claude-sonnet-5" },
  } } });
  await f.adapter.finishModelReport(context, { error: { message: "failed" } });
  assert.equal(f.report()._meta.evidence, "unavailable");
  assert.deepEqual(f.report()._meta.recordedModels, []);
  assert.match(f.report().content.text, /Session model requested from Copilot: `gpt-5\.6-terra`/);
  assert.match(f.report().content.text, /Subagent model requested from Copilot: `claude-sonnet-5`; actual model unavailable/);
  assert.match(f.report().content.text, /failed or was cancelled/);
});

test("overlapping prompts don't attribute another turn's dispatch to this request", async (t) => {
  const f = await fixture(t);
  const context = f.adapter.beginModelReport("session", "run tests with gpt-5.6-luna");
  const other = f.adapter.beginModelReport("session", "a concurrent ordinary prompt");
  f.append([{ type: "model.call_start", data: { model: "some-other-model" } }]);
  await f.adapter.finishModelReport(context);
  await f.adapter.finishModelReport(other);
  assert.deepEqual(f.report()._meta.recordedModels, []);
  assert.equal(f.report()._meta.overlappingPrompts, true);
  assert.equal(f.adapter.modelReportTurns.size, 0);
});

test("journal reads are bounded, skip old and partial records, and reject replaced files or unsafe paths", async (t) => {
  const f = await fixture(t);
  const cursor = snapshotModelJournal(f.root, "session");
  appendFileSync(f.journal, `${"x".repeat(300 * 1024)}\nnot-json\n`);
  f.append([{ type: "model.call_start", data: { model: "current" } }]);
  assert.deepEqual(readModelJournal(f.root, "session", cursor).map((e) => e.data.model), ["current"]);
  const second = snapshotModelJournal(f.root, "session");
  writeFileSync(f.journal, `${JSON.stringify({ type: "model.call_start", data: { model: "replacement" } })}\n`);
  assert.deepEqual(readModelJournal(f.root, "session", second), []);
  rmSync(f.journal);
  symlinkSync(join(f.root, "elsewhere"), f.journal);
  assert.equal(snapshotModelJournal(f.root, "session"), null);
  assert.equal(snapshotModelJournal(f.root, "../escape"), null);
});

