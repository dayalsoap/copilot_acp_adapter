import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeNativeMessage } from "../src/server.js";

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
