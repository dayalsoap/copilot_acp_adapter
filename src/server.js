import { CopilotAcpAdapter } from "./adapter.js";
import { loadConfig } from "./config.js";
import { CopilotRunner } from "./copilot-runner.js";
import { JsonRpcConnection } from "./json-rpc.js";
import { NativeAcpBackend } from "./native-acp-backend.js";

export async function main({ input = process.stdin, output = process.stdout } = {}) {
  const config = loadConfig();
  let connection;
  let nativeBackend;
  let nativeInitializePromise;

  // Environment cannot be injected into a running process, so credential changes
  // have to relaunch `copilot --acp` and re-run the ACP handshake.
  const restartNativeBackend = async () => {
    if (!nativeBackend) {
      return false;
    }
    await nativeBackend.restart({ ...adapter.globalEnv });
    await startNativeInitialize();
    return true;
  };

  const startNativeInitialize = () => {
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
    return nativeInitializePromise;
  };

  const adapter = new CopilotAcpAdapter({
    config,
    runner: new CopilotRunner(config),
    restartBackend: restartNativeBackend,
    notify(method, params) {
      connection?.send({ jsonrpc: "2.0", method, params });
    },
  });
  connection = new JsonRpcConnection(input, output);
  connection.on("parseError", (error) => {
    connection.send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: error.message },
    });
  });
  const inFlight = new Set();
  const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
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
        for (const enhanced of adapter.enhanceNativeMessages(message)) {
          connection?.send(enhanced);
        }
      },
    });
    nativeBackend.on("stderr", (text) => {
      if (text.trim()) {
        process.stderr.write(text);
      }
    });
    startNativeInitialize();
  }

  connection.on("message", (message) => {
    const task = handleMessage({
      adapter,
      nativeBackend,
      // Read lazily: a credential change relaunches the backend and replaces this.
      getNativeInitialize: () => nativeInitializePromise,
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

async function handleMessage({ adapter, nativeBackend, getNativeInitialize, connection, message }) {
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
      await proxyRequest({ adapter, nativeBackend, getNativeInitialize, connection, message });
      return;
    }

    const result = await adapter.handle(message.method, message.params || {});
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

async function proxyRequest({ adapter, nativeBackend, getNativeInitialize, connection, message }) {
  if (message.method === "initialize") {
    const result = adapter.enhanceInitialize(await getNativeInitialize());
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

  // Gate on the method: keying off a bare `params.id` rewrote unrelated requests
  // into session/set_mode.
  const configModeId = isSetConfigOption(message.method)
    ? adapter.nativeModeIdFromConfigOption(
        message.params?.sessionId,
        message.params?.configId || message.params?.id,
        message.params?.value,
      )
    : null;
  if (configModeId !== null) {
    nativeBackend.forwardClientMessage(nativeConfigModeMessage(message, configModeId));
    return;
  }

  const autopilotModeMessage = nativeAutopilotModeMessage(
    message,
    adapter.nativeModeId(message.params?.sessionId, "autopilot"),
  );
  if (autopilotModeMessage) {
    nativeBackend.forwardClientMessage(autopilotModeMessage, (response) => {
      if (response.error) {
        return response;
      }
      return {
        ...response,
        result: {
          stopReason: "end_turn",
          _meta: {
            command: "/autopilot",
            handledBy: "native-acp-mode",
          },
        },
      };
    });
    return;
  }

  nativeBackend.forwardClientMessage(normalizeNativeMessage(message));
}

export function isSetConfigOption(method) {
  return method === "session/set_config_option" || method === "setConfigOption";
}

export function nativeConfigModeMessage(message, modeId) {
  return {
    ...message,
    method: "session/set_mode",
    params: {
      sessionId: message.params?.sessionId,
      modeId,
    },
  };
}

export function nativeAutopilotModeMessage(message, modeId = "autopilot") {
  if (message.method !== "session/prompt" && message.method !== "prompt") {
    return null;
  }

  const promptText = nativePromptText(message.params || {});
  if (promptText === null || promptText.trim() !== "/autopilot") {
    return null;
  }

  return {
    ...message,
    method: "session/set_mode",
    params: {
      sessionId: message.params?.sessionId,
      modeId,
    },
  };
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

function nativePromptText(params) {
  if (typeof params.prompt === "string") {
    return params.prompt;
  }
  if (typeof params.text === "string") {
    return params.text;
  }
  if (typeof params.content === "string") {
    return params.content;
  }
  if (
    Array.isArray(params.prompt) &&
    params.prompt.length === 1 &&
    params.prompt[0]?.type === "text" &&
    typeof params.prompt[0].text === "string"
  ) {
    return params.prompt[0].text;
  }
  return null;
}

function shouldProxyToNative(adapter, message) {
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

function isRequest(message) {
  return message && message.jsonrpc === "2.0" && typeof message.method === "string";
}
