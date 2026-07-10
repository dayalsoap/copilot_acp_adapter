import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readStoredTranscript } from "../src/session-store.js";

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
