import { CopilotAcpAdapter } from "./adapter.js";
import { loadConfig } from "./config.js";
import { CopilotRunner } from "./copilot-runner.js";
import { JsonRpcConnection } from "./json-rpc.js";
import { NativeAcpBackend } from "./native-acp-backend.js";

export async function main({ input = process.stdin, output = process.stdout } = {}) {
  const config = loadConfig();
  let connection;
  let nativeBackend;
  const adapter = new CopilotAcpAdapter({
    config,
    runner: new CopilotRunner(config),
    notify(method, params) {
      connection?.send({ jsonrpc: "2.0", method, params });
    },
  });
  connection = new JsonRpcConnection(input, output);
  const inFlight = new Set();
  const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
  let nativeInitializePromise;
  if (config.copilotBackend === "native-acp") {
    nativeBackend = new NativeAcpBackend({
      command: config.copilotCommand,
      args: config.copilotAcpArgs,
      cwd: config.cwd,
      transport: config.copilotAcpTransport,
      env: {
        COPILOT_AUTO_UPDATE: "false",
        ...adapter.globalEnv,
      },
      requestTimeoutMs: config.copilotAcpRequestTimeoutMs,
      sendToClient(message) {
        connection?.send(adapter.enhanceNativeMessage(message));
      },
    });
    nativeBackend.on("stderr", (text) => {
      if (text.trim()) {
        process.stderr.write(text);
      }
    });
    nativeInitializePromise = nativeBackend.request("initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "copilot-acp-adapter",
        version: "0.1.0",
      },
    });
    nativeInitializePromise.then(
      () => nativeBackend.notify("initialized", {}),
      () => {},
    );
  }

  connection.on("message", (message) => {
    const task = handleMessage({
      adapter,
      nativeBackend,
      nativeInitializePromise,
      connection,
      message,
    }).finally(() => inFlight.delete(task));
    inFlight.add(task);
  });

  await new Promise((resolve) => {
    connection.on("end", resolve);
    connection.start();
  });
  await Promise.allSettled(inFlight);
  clearInterval(keepAlive);
  nativeBackend?.close();
}

async function handleMessage({ adapter, nativeBackend, nativeInitializePromise, connection, message }) {
  if (message?.method === "initialized") {
    return;
  }

  if (!isRequest(message)) {
    if (nativeBackend?.forwardClientMessage(message)) {
      return;
    }
    return;
  }

  try {
    if (nativeBackend && shouldProxyToNative(adapter, message)) {
      await proxyRequest({ adapter, nativeBackend, nativeInitializePromise, connection, message });
      return;
    }

    const result = await adapter.handle(message.method, message.params || {});
    refreshNativeEnv(nativeBackend, adapter);
    sendResult(connection, message, result);
  } catch (error) {
    if (message.id !== undefined) {
      connection.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: error.code || -32603,
          message: error.message || "Internal error",
        },
      });
    }
  }
}

async function proxyRequest({ adapter, nativeBackend, nativeInitializePromise, connection, message }) {
  if (message.method === "initialize") {
    const result = adapter.enhanceInitialize(await nativeInitializePromise);
    sendResult(connection, message, result);
    return;
  }

  if (message.method === "session/new" || message.method === "newSession") {
    const result = await adapter.adoptNativeSession(
      message.params || {},
      await nativeBackend.request("session/new", message.params || {}),
    );
    sendResult(connection, message, result);
    return;
  }

  if (message.method === "session/cancel" || message.method === "cancel") {
    adapter.cancel(message.params || {});
    nativeBackend.notify("session/cancel", message.params || {});
    sendResult(connection, message, { cancelled: true });
    return;
  }

  nativeBackend.forwardClientMessage(normalizeNativeMessage(message));
}

export function normalizeNativeMessage(message) {
  if (message.method !== "session/prompt" && message.method !== "prompt") {
    return message;
  }

  const params = message.params || {};
  if (Array.isArray(params.prompt)) {
    return message.method === "prompt" ? { ...message, method: "session/prompt" } : message;
  }

  const promptText =
    typeof params.prompt === "string"
      ? params.prompt
      : typeof params.text === "string"
        ? params.text
        : typeof params.content === "string"
          ? params.content
          : null;

  if (promptText === null) {
    return message.method === "prompt" ? { ...message, method: "session/prompt" } : message;
  }

  const { text, content, ...rest } = params;
  return {
    ...message,
    method: "session/prompt",
    params: {
      ...rest,
      prompt: [{ type: "text", text: promptText }],
    },
  };
}

function shouldProxyToNative(adapter, message) {
  if (isResponse(message)) {
    return true;
  }
  if (message.method === "initialize" || message.method === "session/new" || message.method === "newSession") {
    return true;
  }
  if (message.method === "session/cancel" || message.method === "cancel") {
    return true;
  }
  return !adapter.shouldHandleLocally(message.method, message.params || {});
}

function sendResult(connection, message, result) {
  if (message.id !== undefined) {
    connection.send({ jsonrpc: "2.0", id: message.id, result });
  }
}

function refreshNativeEnv(nativeBackend, adapter) {
  if (!nativeBackend || nativeBackend.child) {
    return;
  }
  nativeBackend.env = {
    ...nativeBackend.env,
    ...adapter.globalEnv,
  };
}

function isRequest(message) {
  return message && message.jsonrpc === "2.0" && typeof message.method === "string";
}

function isResponse(message) {
  return message && message.id !== undefined && typeof message.method !== "string";
}
