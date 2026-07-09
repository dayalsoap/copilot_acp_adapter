import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readSettings(settingsPath) {
  if (!settingsPath) {
    return {};
  }

  try {
    const text = readFileSync(settingsPath, "utf8");
    return JSON.parse(stripJsonComments(text));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export function writeSettings(settingsPath, settings) {
  if (!settingsPath) {
    throw new Error("No Copilot settings path configured.");
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

export function getSetting(settings, path) {
  return pathParts(path).reduce((value, part) => value?.[part], settings);
}

export function setSetting(settings, path, value) {
  const parts = pathParts(path);
  let target = settings;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(target[part])) {
      target[part] = {};
    }
    target = target[part];
  }
  target[parts.at(-1)] = value;
  return settings;
}

export function unsetSetting(settings, path) {
  const parts = pathParts(path);
  let target = settings;
  for (const part of parts.slice(0, -1)) {
    target = target?.[part];
    if (!isPlainObject(target)) {
      return settings;
    }
  }
  delete target[parts.at(-1)];
  pruneEmptyParents(settings, parts.slice(0, -1));
  return settings;
}

export function listSubagentSettings(settings) {
  const agents = getSetting(settings, "subagents.agents");
  return isPlainObject(agents) ? agents : {};
}

export function subagentSettingPath(agentName) {
  return `subagents.agents.${agentName}`;
}

function pathParts(path) {
  return String(path || "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

function pruneEmptyParents(root, parts) {
  for (let length = parts.length; length > 0; length -= 1) {
    const parentPath = parts.slice(0, length - 1);
    const key = parts[length - 1];
    const parent = parentPath.reduce((value, part) => value?.[part], root);
    if (!isPlainObject(parent?.[key]) || Object.keys(parent[key]).length > 0) {
      return;
    }
    delete parent[key];
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripJsonComments(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}
