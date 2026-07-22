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
    if (sessionCwd !== targetCwd || !workspace.name) {
      continue;
    }

    const updatedAt = fileMtimeIso(eventsPath) || workspace.updated_at || fileMtimeIso(workspacePath);
    sessions.push({
      sessionId: workspace.id || entry.name,
      cwd: workspace.cwd || targetCwd,
      title: workspace.name,
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

export function readStoredTranscript({ sessionStatePath, sessionId }) {
  if (!sessionStatePath || !sessionId) {
    return [];
  }

  const eventsPath = join(sessionStatePath, sessionId, "events.jsonl");
  if (!existsSync(eventsPath)) {
    return [];
  }

  const messages = [];
  for (const line of readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const role = event.type === "user.message"
      ? "user"
      : event.type === "assistant.message"
        ? "agent"
        : null;
    const text = messageText(event.data?.content);
    if (role && text) {
      messages.push({ role, text });
    }
  }
  return messages;
}

export function readStoredUsage({ sessionStatePath, sessionId }) {
  if (!sessionStatePath || !sessionId) {
    return null;
  }
  const eventsPath = join(sessionStatePath, sessionId, "events.jsonl");
  if (!existsSync(eventsPath)) {
    return null;
  }

  let latest = null;
  for (const line of readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
    if (!line.includes('"type":"session.shutdown"')) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      if (event.type === "session.shutdown") {
        latest = event.data || null;
      }
    } catch {
      // Ignore a partial final event while Copilot is still writing it.
    }
  }
  return latest;
}

export function parseWorkspace(text) {
  const result = {};
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!match) {
      continue;
    }
    const block = match[2].match(/^([>|])([+-])?$/);
    if (!block) {
      result[match[1]] = unquoteYamlScalar(match[2]);
      continue;
    }

    const content = [];
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1];
      if (nextLine && !/^\s/.test(nextLine)) {
        break;
      }
      content.push(nextLine.replace(/^\s{1,2}/, ""));
      index += 1;
    }
    let value = block[1] === ">"
      ? content.join(" ").replace(/ +/g, " ")
      : content.join("\n");
    if (block[2] === "-") {
      value = value.replace(/\n+$/, "");
    }
    result[match[1]] = value;
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

function messageText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => typeof part === "string" ? part : part?.type === "text" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}
