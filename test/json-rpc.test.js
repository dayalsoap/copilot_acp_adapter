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

test("replies with newline framing after newline-delimited input", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = new JsonRpcConnection(input, output);
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  connection.on("message", () => {
    connection.send({ jsonrpc: "2.0", id: 1, result: {} });
  });
  connection.start();

  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(text, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
});

test("replies with Content-Length framing after Content-Length input", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = new JsonRpcConnection(input, output);
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  connection.on("message", () => {
    connection.send({ jsonrpc: "2.0", id: 1, result: {} });
  });
  connection.start();

  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
  input.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);

  await new Promise((resolve) => setImmediate(resolve));
  assert.match(text, /^Content-Length: \d+\r\n\r\n/);
});

test("Content-Length framing survives multi-byte UTF-8 payloads", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = new JsonRpcConnection(input, output);
  const messages = [];
  connection.on("message", (message) => messages.push(message));
  connection.start();

  const first = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text: "café — naïve 🚀" }] },
  });
  const second = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
  // Byte length and string length differ here; slicing by characters truncated the body.
  assert.notEqual(Buffer.byteLength(first, "utf8"), first.length);
  input.write(
    `Content-Length: ${Buffer.byteLength(first, "utf8")}\r\n\r\n${first}` +
      `Content-Length: ${Buffer.byteLength(second, "utf8")}\r\n\r\n${second}`,
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].params.prompt[0].text, "café — naïve 🚀");
  assert.equal(messages[1].id, 2);
});

test("Content-Length framing handles a body split across chunks", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = new JsonRpcConnection(input, output);
  const messages = [];
  connection.on("message", (message) => messages.push(message));
  connection.start();

  const body = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ünïcödé" });
  const frame = Buffer.from(
    `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
    "utf8",
  );
  // Split mid-way through a multi-byte character.
  input.write(frame.subarray(0, 40));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 0);
  input.write(frame.subarray(40));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 3, method: "ünïcödé" }]);
});

test("a malformed line is reported without killing the connection", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = new JsonRpcConnection(input, output);
  const messages = [];
  const errors = [];
  connection.on("message", (message) => messages.push(message));
  connection.on("parseError", (error) => errors.push(error));
  connection.start();

  input.write('{oops}\n{"jsonrpc":"2.0","id":4,"method":"initialize"}\n');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(messages.length, 1, "the valid message behind the bad one must still arrive");
  assert.equal(messages[0].id, 4);
});

test("blank lines do not stall messages already buffered behind them", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = new JsonRpcConnection(input, output);
  const messages = [];
  connection.on("message", (message) => messages.push(message));
  connection.start();

  input.write(
    '\n{"jsonrpc":"2.0","id":5,"method":"ping"}\n{"jsonrpc":"2.0","id":6,"method":"ping"}\n',
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages.map((message) => message.id), [5, 6]);
});
