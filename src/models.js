import { spawn } from "node:child_process";

let cachedNativeModels = null;
let cachedNativeModelsPromise = null;
let cachedHelpModels = null;
let cachedHelpModelsPromise = null;

export function parseModelCatalog(value) {
  if (Array.isArray(value)) {
    return uniqueModelIds(value);
  }

  const text = String(value || "").trim();
  if (!text) {
    return ["auto"];
  }

  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error("COPILOT_MODELS JSON value must be an array");
    }
    return uniqueModelIds(parsed);
  }

  return uniqueModelIds(text.split(/[,\s]+/));
}

export function modelDisplayName(modelId) {
  if (!modelId || modelId === "auto") {
    return "Auto";
  }

  return String(modelId)
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) {
        return "GPT";
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export async function listConfiguredModels(config) {
  if (config.copilotModelsOverride) {
    return config.copilotModels;
  }

  if (cachedNativeModels) {
    return cachedNativeModels;
  }
  if (cachedHelpModels) {
    return cachedHelpModels;
  }

  cachedNativeModelsPromise ||= fetchNativeAcpModels({
    command: config.copilotCommand,
    cwd: config.cwd,
    env: { COPILOT_AUTO_UPDATE: "false" },
    timeoutMs: config.modelDiscoveryTimeoutMs,
  });

  const nativeModels = await cachedNativeModelsPromise;
  if (nativeModels) {
    cachedNativeModels = nativeModels;
    return cachedNativeModels;
  }

  cachedNativeModelsPromise = null;
  cachedHelpModelsPromise ||= fetchCopilotConfigModels({
    command: config.copilotCommand,
    cwd: config.cwd,
    env: { COPILOT_AUTO_UPDATE: "false" },
    timeoutMs: config.modelDiscoveryTimeoutMs,
  });

  const helpModels = await cachedHelpModelsPromise;
  if (helpModels) {
    cachedHelpModels = helpModels;
    return cachedHelpModels;
  }

  cachedHelpModelsPromise = null;
  return config.copilotModels;
}

export function fetchCopilotConfigModels({ command, args = ["help", "config"], cwd, env = {}, timeoutMs = 3000 }) {
  return fetchCommandOutput({ command, args, cwd, env, timeoutMs })
    .then((output) => parseCopilotConfigModels(output));
}

export function fetchNativeAcpModels({ command, args = ["--acp", "--no-color"], cwd, env = {}, timeoutMs = 3000 }) {
  return fetchNativeAcpOutput({ command, args, cwd, env, timeoutMs })
    .then((output) => parseNativeAcpModelsOutput(output));
}

export function parseCopilotConfigModels(output) {
  const models = [];
  let inModelSection = false;

  for (const line of String(output || "").split(/\r?\n/)) {
    if (/^\s+`model`:\s/.test(line)) {
      inModelSection = true;
      continue;
    }
    if (inModelSection && /^\s+`[^`]+`:\s/.test(line)) {
      break;
    }

    const match = inModelSection ? line.match(/^\s+-\s+"([^"]+)"/) : null;
    if (match) {
      models.push(match[1]);
    }
  }

  return models.length ? uniqueModelIds(models) : null;
}

function fetchNativeAcpOutput({ command, args = ["--acp", "--no-color"], cwd, env = {}, timeoutMs = 3000 }) {
  if (!command) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let settled = false;
    const timeout = setTimeout(() => finish(null), Number(timeoutMs || 3000));

    function finish(models) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child?.kill();
      resolve(models);
    }

    try {
      child = spawn(command, args, {
        cwd: cwd || process.cwd(),
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      finish(null);
      return;
    }

    child.on("error", () => finish(null));
    child.on("close", () => finish(stdout));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const models = parseNativeAcpModelsOutput(stdout);
      if (models) {
        finish(stdout);
      } else if (hasNativeAcpSessionResult(stdout)) {
        finish(stdout);
      }
    });

    const request = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientInfo: { name: "copilot-acp-adapter", version: "0.1.0" } },
      },
      {
        jsonrpc: "2.0",
        method: "initialized",
        params: {},
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: cwd || process.cwd(), mcpServers: [] },
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n");

    child.stdin.write(`${request}\n`);
  });
}

function fetchCommandOutput({ command, args, cwd, env = {}, timeoutMs = 3000 }) {
  if (!command) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let settled = false;
    const timeout = setTimeout(() => finish(null), Number(timeoutMs || 3000));

    function finish(output) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child?.kill();
      resolve(output);
    }

    try {
      child = spawn(command, args, {
        cwd: cwd || process.cwd(),
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(null);
      return;
    }

    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? stdout : null));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
  });
}

export function parseNativeAcpModelsOutput(output) {
  for (const messageText of splitJsonRpcMessages(output)) {
    try {
      const message = JSON.parse(messageText);
      if (message.id === 2 && message.result) {
        const configModels = modelIdsFromConfigOptions(message.result.configOptions);
        if (configModels.length) {
          return uniqueModelIds(configModels);
        }
        if (Array.isArray(message.result.models?.availableModels)) {
          return uniqueModelIds(
            message.result.models.availableModels.map((model) => model.modelId || model.id || model.name),
          );
        }
      }
    } catch {
      // Ignore non-JSON output from future CLI versions and use the configured fallback.
    }
  }

  return null;
}

function hasNativeAcpSessionResult(output) {
  for (const messageText of splitJsonRpcMessages(output)) {
    try {
      const message = JSON.parse(messageText);
      if (message.id === 2 && message.result) {
        return true;
      }
    } catch {
      // Ignore partial/non-JSON output.
    }
  }
  return false;
}

function splitJsonRpcMessages(output) {
  const text = String(output || "");
  const messages = [];
  let rest = text;

  while (rest.startsWith("Content-Length:")) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return messages;
    }
    const lengthMatch = rest.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      return messages;
    }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(lengthMatch[1]);
    if (rest.length < bodyEnd) {
      return messages;
    }
    messages.push(rest.slice(bodyStart, bodyEnd));
    rest = rest.slice(bodyEnd);
  }

  for (const line of rest.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      messages.push(trimmed);
    }
  }

  return messages;
}

function modelIdsFromConfigOptions(configOptions) {
  const modelOption = Array.isArray(configOptions)
    ? configOptions.find((option) => option?.category === "model" || option?.id === "model")
    : null;
  if (!modelOption || modelOption.type !== "select" || !Array.isArray(modelOption.options)) {
    return [];
  }

  return [
    modelOption.currentValue,
    ...selectOptionValues(modelOption.options),
  ];
}

function selectOptionValues(options) {
  const values = [];
  for (const option of options) {
    if (Array.isArray(option?.options)) {
      values.push(...selectOptionValues(option.options));
    } else {
      values.push(option?.value);
    }
  }
  return values;
}

function uniqueModelIds(values) {
  const result = [];
  for (const value of values) {
    const modelId = String(value || "").trim();
    if (modelId && !result.includes(modelId)) {
      result.push(modelId);
    }
  }
  return result.includes("auto") ? result : ["auto", ...result];
}
