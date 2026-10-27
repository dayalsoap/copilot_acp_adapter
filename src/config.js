import { cwd } from "node:process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadConfig(env = process.env) {
  return {
    copilotCommand: env.COPILOT_COMMAND || defaultCopilotCommand(),
    copilotAcpArgs: parseArgs(env.COPILOT_ACP_ARGS || "--acp --no-color"),
    copilotAcpTransport: env.COPILOT_ACP_TRANSPORT || "fifo",
    copilotAcpRequestTimeoutMs: Number(env.COPILOT_ACP_REQUEST_TIMEOUT_MS || 15000),
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
    requestTimeoutMs: Number(env.COPILOT_REQUEST_TIMEOUT_MS || 0),
    changelogUrl: env.COPILOT_CHANGELOG_URL || "",
    changelogTimeoutMs: Number(env.COPILOT_CHANGELOG_TIMEOUT_MS || 5000),
    copilotHome: env.COPILOT_HOME || join(homedir(), ".copilot"),
    copilotSettingsPath:
      env.COPILOT_SETTINGS_PATH ||
      join(env.COPILOT_HOME || join(homedir(), ".copilot"), "settings.json"),
    copilotSessionStatePath:
      env.COPILOT_SESSION_STATE_PATH ||
      join(env.COPILOT_HOME || join(homedir(), ".copilot"), "session-state"),
  };
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
      throw new Error("COPILOT_ACP_ARGS JSON value must be an array");
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
