import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { NativeAcpBackend } from "../src/native-acp-backend.js";

function createBackend() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("close", null, "SIGTERM");
  const clientMessages = [];
  const backend = new NativeAcpBackend({
    command: "copilot",
    cwd: process.cwd(),
    spawnImpl() {
      return child;
    },
    sendToClient(message) {
      clientMessages.push(message);
    },
    requestTimeoutMs: 100,
  });
  return { backend, child, clientMessages };
}

test("native ACP backend sends newline JSON and resolves responses", async () => {
  const { backend, child } = createBackend();
  const writes = [];
  child.stdin.on("data", (chunk) => {
    writes.push(chunk.toString());
    const message = JSON.parse(chunk.toString());
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } })}\n`);
  });

  const result = await backend.request("initialize", { protocolVersion: 1 });

  assert.deepEqual(result, { ok: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].endsWith("\n"), true);
  assert.equal(writes[0].startsWith("Content-Length:"), false);
});

test("native ACP backend remaps native requests through the client", () => {
  const { backend, child, clientMessages } = createBackend();
  const writes = [];
  child.stdin.on("data", (chunk) => writes.push(JSON.parse(chunk.toString())));

  backend.start();
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "session/request_permission",
    params: { reason: "path" },
  })}\n`);

  assert.equal(clientMessages.length, 1);
  assert.equal(clientMessages[0].method, "session/request_permission");
  assert.equal(clientMessages[0].id, "native-1");

  assert.equal(backend.forwardClientMessage({
    jsonrpc: "2.0",
    id: "native-1",
    result: { outcome: { outcome: "selected", optionId: "allow" } },
  }), true);
  assert.deepEqual(writes[0], {
    jsonrpc: "2.0",
    id: 7,
    result: { outcome: { outcome: "selected", optionId: "allow" } },
  });
});
