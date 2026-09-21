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
    command: "copilot", cwd: process.cwd(), spawnImpl() { return child; },
    sendToClient(message) { clientMessages.push(message); }, requestTimeoutMs: 100,
  });
  return { backend, child, clientMessages };
}

function forwardedResponse(child, backend, transform) {
  let forwarded;
  child.stdin.on("data", (chunk) => { forwarded = JSON.parse(chunk.toString()); });
  backend.forwardClientMessage({ jsonrpc: "2.0", id: 9, method: "session/set_mode", params: { sessionId: "s1", modeId: "autopilot" } }, transform);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: forwarded.id, result: {} })}\n`);
}

test("native ACP backend sends newline JSON and resolves responses", async () => {
  const { backend, child } = createBackend(); const writes = [];
  child.stdin.on("data", (chunk) => { writes.push(chunk.toString()); const message = JSON.parse(chunk.toString()); child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } })}\n`); });
  assert.deepEqual(await backend.request("initialize", { protocolVersion: 1 }), { ok: true });
  assert.equal(writes[0].endsWith("\n"), true); assert.equal(writes[0].startsWith("Content-Length:"), false);
});

test("native ACP backend remaps native requests through the client", () => {
  const { backend, child, clientMessages } = createBackend(); const writes = [];
  child.stdin.on("data", (chunk) => writes.push(JSON.parse(chunk.toString()))); backend.start();
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { reason: "path" } })}\n`);
  assert.equal(clientMessages[0].id, "native-1");
  assert.equal(backend.forwardClientMessage({ jsonrpc: "2.0", id: "native-1", result: { outcome: { outcome: "cancelled" } } }), true);
  assert.deepEqual(writes[0], { jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } });
});

test("native ACP backend delivers asynchronous transformed responses", async () => {
  const { backend, child, clientMessages } = createBackend();
  forwardedResponse(child, backend, async (response) => ({ ...response, result: { stopReason: "end_turn" } }));
  await backend.waitForDeliveries();
  assert.deepEqual(clientMessages[0], { jsonrpc: "2.0", id: 9, result: { stopReason: "end_turn" } });
});

test("a client send failure after a successful transform does not duplicate delivery", async () => {
  const { backend, child } = createBackend(); let sends = 0; const errors = [];
  backend.sendToClient = () => { sends += 1; throw new Error("client disconnected"); };
  backend.on("backendError", (error) => errors.push(error));
  forwardedResponse(child, backend, async (response) => response);
  await backend.waitForDeliveries();
  assert.equal(sends, 1);
  assert.match(errors[0].message, /client disconnected/);
});

test("invalid native JSON rejects outstanding requests promptly", async () => {
  const { backend, child } = createBackend();
  const pending = backend.request("initialize", {});
  child.stdout.write("not-json" + String.fromCharCode(10));
  await assert.rejects(pending, /Invalid JSON-RPC message/);
  assert.equal(backend.pendingBackendRequests.size, 0);
});

test("a rejected asynchronous transform delivers the original response without crashing", async () => {
  const { backend, child, clientMessages } = createBackend(); const errors = [];
  backend.on("backendError", (error) => errors.push(error));
  forwardedResponse(child, backend, async () => { throw new Error("report failed"); });
  await backend.waitForDeliveries();
  assert.deepEqual(clientMessages[0], { jsonrpc: "2.0", id: 9, result: {} });
  assert.match(errors[0].message, /report failed/);
});

test("a backend crash answers a client request even with an asynchronous transform", async () => {
  const { backend, child, clientMessages } = createBackend();
  backend.forwardClientMessage({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: { sessionId: "s1" } }, async () => { throw new Error("late report"); });
  child.emit("close", 1, null); await new Promise((resolve) => setImmediate(resolve)); await backend.waitForDeliveries();
  const response = clientMessages.find((message) => message.id === 7);
  assert.equal(response.error.code, -32000); assert.equal(backend.forwardedClientRequests.size, 0);
});

test("restart relaunches the backend with updated environment", async () => {
  const spawned = []; const backend = new NativeAcpBackend({ command: "copilot", transport: "stdio", env: {}, sendToClient() {}, requestTimeoutMs: 500,
    spawnImpl(command, args, options) { const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit("close", null, "SIGTERM"); spawned.push(options.env.COPILOT_GITHUB_TOKEN ?? ""); child.stdin.on("data", (chunk) => { const message = JSON.parse(chunk.toString()); child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`); }); return child; }, });
  await backend.request("initialize", {}); await backend.restart({ COPILOT_GITHUB_TOKEN: "ghp_token" }); await backend.request("initialize", {});
  assert.deepEqual(spawned, ["", "ghp_token"]);
});
