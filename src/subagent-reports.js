import { closeSync, lstatSync, openSync, readSync, fstatSync } from "node:fs";
import { resolve, sep } from "node:path";

// A bounded tail avoids making prompt completion depend on an unbounded journal.
const MAX_EVENT_BYTES = 256 * 1024;

/**
 * Reads only the tail of one known Copilot session's event file. Session and
 * tool-call identity are both required; callers must only supply tool calls
 * observed in the current native ACP turn.
 */
export function readSubagentCompletions({ sessionStatePath, sessionId, toolCallIds }) {
  const ids = new Set((toolCallIds || []).filter((id) => typeof id === "string" && id));
  const eventsPath = safeEventsPath(sessionStatePath, sessionId);
  if (!eventsPath || ids.size === 0) {
    return new Map();
  }

  let fd;
  try {
    // Check type before opening: opening a FIFO can block indefinitely. lstat
    // also deliberately rejects symlinks instead of following them.
    const sessionDirectory = resolve(sessionStatePath, sessionId);
    const directoryStat = lstatSync(sessionDirectory);
    const fileStat = lstatSync(eventsPath);
    if (!directoryStat.isDirectory() || fileStat.isSymbolicLink() || !fileStat.isFile()) {
      return new Map();
    }
    fd = openSync(eventsPath, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return new Map();
    const size = stat.size;
    const bytes = Math.min(size, MAX_EVENT_BYTES);
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, Math.max(0, size - bytes));
    // A concurrent truncation can produce a short read. Parse only bytes read.
    const text = buffer.subarray(0, read).toString("utf8");
    // The first line may have been cut in half; JSON parsing deliberately
    // ignores it, as it also does a concurrently-written final line.
    const completions = new Map();
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("subagent.completed")) continue;
      try {
        const event = JSON.parse(line);
        const toolCallId = event?.data?.toolCallId;
        if (event?.type === "subagent.completed" && ids.has(toolCallId)) {
          completions.set(toolCallId, event);
        }
      } catch {
        // Partial or malformed JSONL must never affect a prompt.
      }
    }
    return completions;
  } catch {
    return new Map();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing a descriptor after a concurrent teardown is non-fatal.
      }
    }
  }
}

export function completionEvidence(event) {
  if (!event || event.type !== "subagent.completed") return null;
  const data = event.data || {};
  return {
    toolCallId: typeof data.toolCallId === "string" ? data.toolCallId : "",
    agentName: typeof data.agentName === "string" ? data.agentName : "",
    requestedModel: typeof data.model === "string" ? data.model : "",
    firstDispatchedModel: typeof data.firstDispatchedModel === "string" ? data.firstDispatchedModel : "",
    explicitModelOverride: typeof data.explicitModelOverride === "string" ? data.explicitModelOverride : "",
    agentId: typeof event.agentId === "string" ? event.agentId : "",
  };
}

export function assertCompletedSubagentEvidence(event, { toolCallId, agentName, requestedModel, firstDispatchedModel, explicitModelOverride }) {
  const evidence = completionEvidence(event);
  const problems = [];
  if (!evidence) problems.push("missing correlated subagent.completed event");
  else {
    if (toolCallId && evidence.toolCallId !== toolCallId) problems.push(`toolCallId=${evidence.toolCallId || "missing"}`);
    if (agentName && evidence.agentName !== agentName) problems.push(`agent=${evidence.agentName || "missing"}`);
    if (requestedModel && evidence.requestedModel !== requestedModel) problems.push(`requested=${evidence.requestedModel || "missing"}`);
    if (firstDispatchedModel && evidence.firstDispatchedModel !== firstDispatchedModel) problems.push(`firstDispatched=${evidence.firstDispatchedModel || "missing"}`);
    if (explicitModelOverride && evidence.explicitModelOverride !== explicitModelOverride) problems.push(`explicitModelOverride=${evidence.explicitModelOverride || "missing"}`);
  }
  if (problems.length) throw new Error(`Subagent completion evidence failed: ${problems.join(", ")}`);
  return evidence;
}

function safeEventsPath(sessionStatePath, sessionId) {
  if (!sessionStatePath || typeof sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return "";
  const root = resolve(sessionStatePath);
  const candidate = resolve(root, sessionId, "events.jsonl");
  return candidate.startsWith(`${root}${sep}`) ? candidate : "";
}
