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

test("native ACP backend can transform a forwarded response", () => {
  const { backend, child, clientMessages } = createBackend();
  let forwarded;
  child.stdin.on("data", (chunk) => {
    forwarded = JSON.parse(chunk.toString());
  });

  backend.forwardClientMessage({
    jsonrpc: "2.0",
    id: 9,
    method: "session/set_mode",
    params: { sessionId: "s1", modeId: "autopilot" },
  }, (response) => ({ ...response, result: { stopReason: "end_turn" } }));
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: forwarded.id, result: {} })}\n`);

  assert.deepEqual(clientMessages[0], {
    jsonrpc: "2.0",
    id: 9,
    result: { stopReason: "end_turn" },
  });
});

test("a backend crash answers the client requests it left in flight", async () => {
  const { backend, child, clientMessages } = createBackend();
  child.stdin.on("data", () => {});

  backend.forwardClientMessage({
    jsonrpc: "2.0",
    id: 7,
    method: "session/prompt",
    params: { sessionId: "s1" },
  });
  assert.equal(backend.forwardedClientRequests.size, 1);

  child.emit("close", 1, null);
  await new Promise((resolve) => setImmediate(resolve));

  const response = clientMessages.find((message) => message.id === 7);
  assert.ok(response, "the client must not be left waiting on a dead backend");
  assert.equal(response.error.code, -32000);
  assert.match(response.error.message, /exited with code 1/);
  assert.equal(backend.forwardedClientRequests.size, 0);
  assert.equal(backend.forwardedClientResponses.size, 0);
});

test("restart relaunches the backend with updated environment", async () => {
  const spawned = [];
  const backend = new NativeAcpBackend({
    command: "copilot",
    transport: "stdio",
    env: {},
    sendToClient() {},
    requestTimeoutMs: 500,
    spawnImpl(command, args, options) {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit("close", null, "SIGTERM");
      spawned.push(options.env.COPILOT_GITHUB_TOKEN ?? "");
      child.stdin.on("data", (chunk) => {
        const message = JSON.parse(chunk.toString());
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
      });
      return child;
    },
  });

  await backend.request("initialize", {});
  await backend.restart({ COPILOT_GITHUB_TOKEN: "ghp_token" });
  await backend.request("initialize", {});

  assert.deepEqual(spawned, ["", "ghp_token"]);
});
