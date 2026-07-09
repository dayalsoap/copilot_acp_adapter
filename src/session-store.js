import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export function listStoredSessions({ sessionStatePath, cwd, limit = 50 }) {
  const targetCwd = resolve(cwd || process.cwd());
  const sessions = [];

  if (!sessionStatePath || !existsSync(sessionStatePath)) {
    return [];
  }

  for (const entry of readdirSync(sessionStatePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sessionDir = join(sessionStatePath, entry.name);
    const workspacePath = join(sessionDir, "workspace.yaml");
    const eventsPath = join(sessionDir, "events.jsonl");
    if (!existsSync(workspacePath) || !existsSync(eventsPath)) {
      continue;
    }

    const workspace = parseWorkspace(readFileSync(workspacePath, "utf8"));
    const sessionCwd = workspace.cwd ? resolve(workspace.cwd) : "";
    if (sessionCwd !== targetCwd) {
      continue;
    }

    const updatedAt = fileMtimeIso(eventsPath) || workspace.updated_at || fileMtimeIso(workspacePath);
    sessions.push({
      sessionId: workspace.id || entry.name,
      cwd: workspace.cwd || targetCwd,
      title: workspace.name || "(untitled)",
      updatedAt,
    });
  }

  sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return sessions.slice(0, limit);
}

export function readStoredSession({ sessionStatePath, sessionId }) {
  if (!sessionStatePath || !sessionId) {
    return null;
  }

  const workspacePath = join(sessionStatePath, sessionId, "workspace.yaml");
  if (!existsSync(workspacePath)) {
    return null;
  }

  const workspace = parseWorkspace(readFileSync(workspacePath, "utf8"));
  return {
    sessionId: workspace.id || sessionId,
    cwd: workspace.cwd || "",
    title: workspace.name || "(untitled)",
    updatedAt: workspace.updated_at || fileMtimeIso(workspacePath),
  };
}

export function parseWorkspace(text) {
  const result = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!match) {
      continue;
    }
    result[match[1]] = unquoteYamlScalar(match[2]);
  }
  return result;
}

function fileMtimeIso(path) {
  return statSync(path).mtime.toISOString();
}

function unquoteYamlScalar(value) {
  const text = String(value || "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}
