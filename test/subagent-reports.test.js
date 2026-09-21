import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertCompletedSubagentEvidence,
  completionEvidence,
  readSubagentCompletions,
} from "../src/subagent-reports.js";

function event(toolCallId, agentName, model, firstDispatchedModel, explicitModelOverride = model) {
  return { type: "subagent.completed", agentId: `agent-${agentName}`, data: { toolCallId, agentName, model, firstDispatchedModel, explicitModelOverride } };
}

function state(lines) {
  const root = mkdtempSync(join(tmpdir(), "copilot-subagent-evidence-"));
  mkdirSync(join(root, "session-1"));
  writeFileSync(join(root, "session-1", "events.jsonl"), lines.join("\n"));
  return root;
}

test("correlates only requested tool calls in one session despite malformed and other-agent records", (t) => {
  const root = state([
    "not json",
    JSON.stringify(event("other-call", "other", "terra", "terra")),
    JSON.stringify(event("call-1", "test-diagnostician", "luna", "mai-code-1.1-flash")),
    '{"type":"subagent.completed"',
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const found = readSubagentCompletions({ sessionStatePath: root, sessionId: "session-1", toolCallIds: ["call-1"] });
  assert.equal(found.size, 1);
  assert.deepEqual(completionEvidence(found.get("call-1")), {
    toolCallId: "call-1", agentName: "test-diagnostician", requestedModel: "luna",
    firstDispatchedModel: "mai-code-1.1-flash", explicitModelOverride: "luna", agentId: "agent-test-diagnostician",
  });
});

test("missing files, unsafe session ids, and unknown dispatch are non-fatal", () => {
  assert.deepEqual([...readSubagentCompletions({ sessionStatePath: "/missing", sessionId: "session-1", toolCallIds: ["x"] })], []);
  assert.deepEqual([...readSubagentCompletions({ sessionStatePath: "/tmp", sessionId: "../escape", toolCallIds: ["x"] })], []);
  const evidence = completionEvidence(event("x", "test-diagnostician", "luna", ""));
  assert.equal(evidence.firstDispatchedModel, "");
});

test("reader rejects symlinks and non-regular event paths before opening", (t) => {
  const root = mkdtempSync(join(tmpdir(), "copilot-subagent-types-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "session-1"));
  writeFileSync(join(root, "real.jsonl"), JSON.stringify(event("call", "agent", "m", "m")));
  symlinkSync(join(root, "real.jsonl"), join(root, "session-1", "events.jsonl"));
  assert.equal(readSubagentCompletions({ sessionStatePath: root, sessionId: "session-1", toolCallIds: ["call"] }).size, 0);
  rmSync(join(root, "session-1", "events.jsonl"));
  mkdirSync(join(root, "session-1", "events.jsonl"));
  assert.equal(readSubagentCompletions({ sessionStatePath: root, sessionId: "session-1", toolCallIds: ["call"] }).size, 0);
  rmSync(join(root, "session-1", "events.jsonl"), { recursive: true });
  assert.equal(spawnSync("mkfifo", [join(root, "session-1", "events.jsonl")]).status, 0);
  assert.equal(readSubagentCompletions({ sessionStatePath: root, sessionId: "session-1", toolCallIds: ["call"] }).size, 0, "FIFO is rejected before open and cannot block");
  rmSync(join(root, "session-1"), { recursive: true });
  symlinkSync(join(root, "real.jsonl"), join(root, "session-1"));
  assert.equal(readSubagentCompletions({ sessionStatePath: root, sessionId: "session-1", toolCallIds: ["call"] }).size, 0);
});

test("reader parses the bounded 256KiB tail without replaying oversized history", (t) => {
  const root = state(["x".repeat(300 * 1024), JSON.stringify(event("call-1", "agent", "luna", "luna"))]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const found = readSubagentCompletions({ sessionStatePath: root, sessionId: "session-1", toolCallIds: ["call-1"] });
  assert.equal(found.size, 1);
});

test("offline assertion helper accepts matching evidence and rejects mismatch", () => {
  const completed = event("call-1", "test-diagnostician", "luna", "luna");
  assert.equal(assertCompletedSubagentEvidence(completed, {
    toolCallId: "call-1", agentName: "test-diagnostician", requestedModel: "luna", firstDispatchedModel: "luna", explicitModelOverride: "luna",
  }).firstDispatchedModel, "luna");
  assert.throws(() => assertCompletedSubagentEvidence(completed, { requestedModel: "terra" }), /requested=luna/);
  assert.throws(() => assertCompletedSubagentEvidence(completed, { explicitModelOverride: "terra" }), /explicitModelOverride=luna/);
  assert.throws(() => assertCompletedSubagentEvidence(null, { requestedModel: "luna" }), /missing correlated/);
});
