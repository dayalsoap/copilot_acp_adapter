import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSessionListResult } from "../src/session-title.js";

test("session list titles collapse embedded newlines for single-line pickers", () => {
  const result = normalizeSessionListResult({
    sessions: [
      { sessionId: "a", title: "This PR:\n\nhttps://example/pull/1447\n\n  Can you  review?" },
      { sessionId: "b" },
    ],
    nextCursor: "c",
  });
  assert.deepEqual(result, {
    sessions: [
      { sessionId: "a", title: "This PR: https://example/pull/1447 Can you review?" },
      { sessionId: "b" },
    ],
    nextCursor: "c",
  });
  assert.equal(normalizeSessionListResult(null), null);
});
