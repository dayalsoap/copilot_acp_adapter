import { cwd } from "node:process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseModelCatalog } from "./models.js";

export function loadConfig(env = process.env) {
  const copilotModelsOverride = Boolean(env.COPILOT_MODELS);

  return {
    copilotCommand: env.COPILOT_COMMAND || defaultCopilotCommand(),
    copilotArgs: parseArgs(env.COPILOT_ARGS || "--allow-all-tools --silent --no-color"),
    copilotTransport: env.COPILOT_TRANSPORT || "prompt",
    copilotModel: env.COPILOT_MODEL || findArgValue(parseArgs(env.COPILOT_ARGS || ""), "--model") || "auto",
    copilotModelName: env.COPILOT_MODEL_NAME || "",
    copilotModels: copilotModelsOverride ? parseModelCatalog(env.COPILOT_MODELS) : ["auto"],
    copilotModelsOverride,
    modelDiscoveryTimeoutMs: Number(env.COPILOT_MODEL_DISCOVERY_TIMEOUT_MS || 3000),
    copilotMode: env.COPILOT_MODE || findArgValue(parseArgs(env.COPILOT_ARGS || ""), "--mode") || "agent",
    cwd: env.COPILOT_CWD || cwd(),
    githubHost: normalizeHost(env.GITHUB_HOST || "https://github.com"),
    enterpriseHost: env.GITHUB_ENTERPRISE_HOST || env.GHE_HOST || "",
    apiKey:
      env.GITHUB_COPILOT_API_KEY ||
      env.COPILOT_GITHUB_TOKEN ||
      env.GITHUB_TOKEN ||
      env.GH_TOKEN ||
      env.COPILOT_API_KEY ||
      "",
    ghCommand: env.GH_COMMAND || "gh",
    loginBrowser: env.COPILOT_LOGIN_BROWSER || "echo",
    loginHeadless: env.COPILOT_LOGIN_HEADLESS !== "0",
    forceTtyDirectCommands: env.COPILOT_FORCE_TTY_DIRECT_COMMANDS === "1",
    requestTimeoutMs: Number(env.COPILOT_REQUEST_TIMEOUT_MS || 0),
    copilotHome: env.COPILOT_HOME || join(homedir(), ".copilot"),
    copilotSettingsPath:
      env.COPILOT_SETTINGS_PATH ||
      join(env.COPILOT_HOME || join(homedir(), ".copilot"), "settings.json"),
    copilotSessionStatePath:
      env.COPILOT_SESSION_STATE_PATH ||
      join(env.COPILOT_HOME || join(homedir(), ".copilot"), "session-state"),
  };
}

export function findArgValue(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      return args[index + 1] || "";
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return "";
}

function defaultCopilotCommand() {
  const localBin = join(homedir(), ".local", "bin", "copilot");
  return existsSync(localBin) ? localBin : "copilot";
}

export function normalizeHost(host) {
  if (!host) {
    return "";
  }
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
}

export function parseArgs(value) {
  if (Array.isArray(value)) {
    return value.map(String);
  }

  const text = String(value || "").trim();
  if (!text) {
    return [];
  }

  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error("COPILOT_ARGS JSON value must be an array");
    }
    return parsed.map(String);
  }

  return text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(unquoteArg) || [];
}

function unquoteArg(arg) {
  if (
    (arg.startsWith('"') && arg.endsWith('"')) ||
    (arg.startsWith("'") && arg.endsWith("'"))
  ) {
    return arg.slice(1, -1);
  }
  return arg;
}
