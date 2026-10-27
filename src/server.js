import { CopilotAcpAdapter } from "./adapter.js";
import { loadConfig } from "./config.js";
import { CopilotRunner } from "./copilot-runner.js";
import { JsonRpcConnection } from "./json-rpc.js";
import { NativeAcpBackend } from "./native-acp-backend.js";
import { normalizeSessionListResult } from "./session-title.js";

export async function main({ input = process.stdin, output = process.stdout } = {}) {
  const config = loadConfig();
  let connection;
  let nativeBackend;
  let nativeInitializePromise;
  let nativeInitializeParams;

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
    nativeInitializePromise = nativeBackend.request("initialize", nativeInitializeParams);
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

  connection.on("message", (message) => {
    const task = handleMessage({
      adapter,
      nativeBackend,
      // Read lazily: a credential change relaunches the backend and replaces this.
      getNativeInitialize: (params) => {
        // Wait for the actual client's initialize request; extensions and
        // filesystem/terminal capabilities must survive the proxy and restart.
        nativeInitializeParams ||= params || { protocolVersion: 1 };
        return nativeInitializePromise || startNativeInitialize();
      },
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
  // Flush transforms already registered when EOF arrived. New client requests
  // cannot arrive after EOF, but a transform created later is not included.
  await nativeBackend?.waitForDeliveries();
  clearInterval(keepAlive);
  nativeBackend?.close();
}

async function handleMessage({ adapter, nativeBackend, getNativeInitialize, connection, message }) {
  if (message?.method === "initialized") {
    return;
  }

  if (!isRequest(message)) {
    nativeBackend.forwardClientMessage(message);
    return;
  }

  try {
    if (shouldProxyToNative(adapter, message)) {
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
    const result = adapter.enhanceInitialize(await getNativeInitialize(message.params));
    sendResult(connection, message, result);
    return;
  }

  await getNativeInitialize();

  if (message.method === "session/new" || message.method === "newSession") {
    const result = await adapter.adoptNativeSession(
      message.params || {},
      await nativeBackend.request("session/new", message.params || {}),
    );
    sendResult(connection, message, result);
    return;
  }

  if (message.method === "session/load") {
    const result = await adapter.adoptNativeSession(
      message.params || {},
      await nativeBackend.request("session/load", message.params || {}),
    );
    sendResult(connection, message, result);
    return;
  }

  if (message.method === "session/list") {
    const result = await nativeBackend.request("session/list", message.params || {});
    sendResult(connection, message, normalizeSessionListResult(result));
    return;
  }

  const exiting = isNativeExit(message);
  if (exiting || message.method === "session/close" || message.method === "closeSession") {
    const params = { sessionId: message.params?.sessionId };
    const result = await nativeBackend.request("session/close", params);
    adapter.closeSession(params);
    sendResult(connection, message, exiting ? { stopReason: "end_turn" } : result);
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
  if (autopilotModeMessage && !adapter.nativeCommands.get(message.params?.sessionId)?.some((command) => command.name === "autopilot")) {
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

  const nativeMessage = normalizeNativeMessage(await rewriteChangelogSummary(adapter, connection, message));
  if (!nativeMessage) {
    return;
  }
  // The user's own text, so release notes in a rewritten /changelog summary
  // can't trigger a model report.
  const report = nativeMessage.method === "session/prompt"
    ? adapter.beginModelReport(nativeMessage.params?.sessionId, modelPromptText(message.params || {}))
    : null;
  try {
    nativeBackend.forwardClientMessage(nativeMessage, (response) => enhanceNativePromptResponse(adapter, nativeMessage, response, report));
  } catch (error) {
    await adapter.finishModelReport(report, { error });
    throw error;
  }
}

// `/changelog summarize` runs as an ordinary native prompt carrying the notes.
// Returns null once a fetch failure has been answered locally.
export async function rewriteChangelogSummary(adapter, connection, message) {
  const isPrompt = message.method === "session/prompt" || message.method === "prompt";
  if (!isPrompt || !adapter.isChangelogSummary(message.params || {})) {
    return message;
  }
  let text;
  try {
    text = await adapter.changelogSummaryPrompt(message.params || {});
  } catch (error) {
    sendResult(connection, message, adapter.changelogFailure(message.params?.sessionId, { name: "/changelog" }, error));
    return null;
  }
  const { text: _text, content: _content, ...params } = message.params || {};
  return { ...message, method: "session/prompt", params: { ...params, prompt: [{ type: "text", text }] } };
}

// Exported for an offline server-hook regression test. This is called only for
// the completed prompt response, never for streamed session/update messages.
export async function enhanceNativePromptResponse(adapter, nativeMessage, response, report = null) {
  try {
    if (!response.error && (nativeMessage.method === "session/prompt" || nativeMessage.method === "prompt")) {
      await adapter.reportNativeSubagentDispatch(nativeMessage.params?.sessionId);
    }
  } finally {
    await adapter.finishModelReport?.(report, response);
  }
  return response;
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

function modelPromptText(params) {
  if (Array.isArray(params.prompt)) {
    return params.prompt.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
  }
  return nativePromptText(params) || "";
}

function shouldProxyToNative(adapter, message) {
  if (isNativeExit(message)) return true;
  if (message.method === "initialize" || message.method === "session/new" || message.method === "newSession") {
    return true;
  }
  if (message.method === "session/cancel" || message.method === "cancel") {
    return true;
  }
  return !adapter.shouldHandleLocally(message.method, message.params || {});
}

function isNativeExit(message) {
  return (message.method === "session/prompt" || message.method === "prompt") &&
    nativePromptText(message.params || {})?.trim() === "/exit";
}

function sendResult(connection, message, result) {
  if (message.id !== undefined) {
    connection.send({ jsonrpc: "2.0", id: message.id, result });
  }
}

function isRequest(message) {
  return message && message.jsonrpc === "2.0" && typeof message.method === "string";
}
