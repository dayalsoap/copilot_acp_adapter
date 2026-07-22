import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  listStoredSessions,
  parseWorkspace,
  readStoredTranscript,
  readStoredUsage,
} from "../src/session-store.js";

test("parses generated multiline session summaries", () => {
  assert.deepEqual(parseWorkspace([
    "id: session-1",
    "name: |-",
    "  First summary line",
    "  Second summary line...",
    "user_named: false",
  ].join("\n")), {
    id: "session-1",
    name: "First summary line\nSecond summary line...",
    user_named: "false",
  });
});

test("lists generated summaries and omits unfinished unnamed sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-list-"));
  for (const [id, name] of [["summarized", "name: |-\n  Detailed summary\n  More context..."], ["unfinished", ""]]) {
    const session = join(root, id);
    mkdirSync(session);
    writeFileSync(join(session, "workspace.yaml"), `id: ${id}\ncwd: /repo\n${name}\n`);
    writeFileSync(join(session, "events.jsonl"), "");
  }

  assert.deepEqual(listStoredSessions({ sessionStatePath: root, cwd: "/repo" }), [{
    sessionId: "summarized",
    cwd: "/repo",
    title: "Detailed summary\nMore context...",
    updatedAt: statUpdatedAt(join(root, "summarized", "events.jsonl")),
  }]);
});

test("reads user and assistant messages from Copilot events", () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-transcript-"));
  const session = join(root, "session-1");
  mkdirSync(session);
  writeFileSync(join(session, "events.jsonl"), [
    JSON.stringify({ type: "user.message", data: { content: "hello" } }),
    "not json",
    JSON.stringify({ type: "tool.execution_complete", data: { content: "ignored" } }),
    JSON.stringify({ type: "assistant.message", data: { content: "hi" } }),
  ].join("\n"));

  assert.deepEqual(readStoredTranscript({ sessionStatePath: root, sessionId: "session-1" }), [
    { role: "user", text: "hello" },
    { role: "agent", text: "hi" },
  ]);
});

test("reads the latest completed usage snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-usage-"));
  const session = join(root, "session-1");
  mkdirSync(session);
  writeFileSync(join(session, "events.jsonl"), [
    JSON.stringify({ type: "session.shutdown", data: { currentTokens: 10 } }),
    JSON.stringify({ type: "session.shutdown", data: { currentTokens: 20 } }),
  ].join("\n"));
  assert.equal(readStoredUsage({ sessionStatePath: root, sessionId: "session-1" }).currentTokens, 20);
});

function statUpdatedAt(path) {
  return statSync(path).mtime.toISOString();
}
