import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { JsonRpcConnection } from "../src/json-rpc.js";

test("reads Content-Length framed JSON-RPC messages", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = new JsonRpcConnection(input, output);
  const messages = [];
  connection.on("message", (message) => messages.push(message));
  connection.start();

  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
  input.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 1, method: "initialize" }]);
});

test("reads newline-delimited JSON-RPC messages", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = new JsonRpcConnection(input, output);
  const messages = [];
  connection.on("message", (message) => messages.push(message));
  connection.start();

  input.write('{"jsonrpc":"2.0","id":2,"method":"session/new"}\n');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages[0].method, "session/new");
});
