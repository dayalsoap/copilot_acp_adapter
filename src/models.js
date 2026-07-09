import { spawnSync } from "node:child_process";

export const DEFAULT_MODEL_IDS = Object.freeze([
  "auto",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "claude-fable-5",
  "claude-opus-4.8",
  "claude-opus-4.8-fast",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-opus-4.5",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gpt-5-mini",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "kimi-k2.7-code",
]);

let cachedNativeModels = null;

export function parseModelCatalog(value) {
  if (Array.isArray(value)) {
    return uniqueModelIds(value);
  }

  const text = String(value || "").trim();
  if (!text) {
    return [...DEFAULT_MODEL_IDS];
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

export function listConfiguredModels(config) {
  if (config.copilotModelsOverride) {
    return config.copilotModels;
  }

  if (cachedNativeModels) {
    return cachedNativeModels;
  }

  cachedNativeModels =
    fetchNativeAcpModels({
      command: config.copilotCommand,
      cwd: config.cwd,
      env: { COPILOT_AUTO_UPDATE: "false" },
      timeoutMs: config.modelDiscoveryTimeoutMs,
    }) || config.copilotModels;
  return cachedNativeModels;
}

export function fetchNativeAcpModels({ command, args = ["--acp", "--no-color"], cwd, env = {}, timeoutMs = 3000 }) {
  if (!command) {
    return null;
  }

  const sessionId = "copilot-acp-model-discovery";
  const input = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientInfo: { name: "copilot-acp-adapter", version: "0.1.0" } },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { sessionId, cwd: cwd || process.cwd(), mcpServers: [] },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "session/close",
      params: { sessionId },
    },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n");

  const result = spawnSync(command, args, {
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...env },
    input: `${input}\n`,
    encoding: "utf8",
    timeout: Number(timeoutMs || 3000),
    maxBuffer: 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  return parseNativeAcpModelsOutput(result.stdout);
}

export function parseNativeAcpModelsOutput(output) {
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const message = JSON.parse(line);
      if (message.id === 2 && Array.isArray(message.result?.models?.availableModels)) {
        return uniqueModelIds(
          message.result.models.availableModels.map((model) => model.modelId || model.id || model.name),
        );
      }
    } catch {
      // Ignore non-JSON output from future CLI versions and fall back to the static catalog.
    }
  }

  return null;
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
