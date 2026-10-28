import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve, sep } from "node:path";
import { completionEvidence, SUBAGENT_END_EVENTS } from "./subagent-reports.js";

const MAX_EVENT_BYTES = 256 * 1024;

export function mentionedModels(prompt, knownModels = []) {
  const text = String(prompt || "");
  if (text.trimStart().startsWith("/")) return [];
  const found = new Set();
  // A mention is a reporting trigger, never evidence that routing changed.
  for (const match of text.matchAll(/\b(?:gpt|claude|gemini|mai|deepseek|o[1-9])(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)+\b/gi)) {
    found.add(match[0].toLowerCase());
  }
  for (const id of knownModels) {
    if (typeof id !== "string" || !id || id === "auto") continue;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const verbal = escaped.replaceAll("-", "[-\\s]+");
    if (new RegExp(`(?<![\\w.-])${verbal}(?![\\w.-])`, "i").test(text)) found.add(id);
  }
  return [...found];
}

function withJournal(sessionStatePath, sessionId, callback) {
  if (!sessionStatePath || typeof sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  const root = resolve(sessionStatePath);
  const directory = resolve(root, sessionId);
  if (!directory.startsWith(`${root}${sep}`)) return null;
  let fd;
  try {
    if (!lstatSync(directory).isDirectory()) return null;
    const path = resolve(directory, "events.jsonl");
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    return callback(fd, stat);
  } catch (error) {
    return error?.code === "ENOENT" ? { missing: true } : null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Reporting never changes prompt execution. */ }
    }
  }
}

export function snapshotModelJournal(sessionStatePath, sessionId) {
  return withJournal(sessionStatePath, sessionId, (fd, stat) => {
    const suffix = Buffer.alloc(Math.min(64, stat.size));
    const bytes = readSync(fd, suffix, 0, suffix.length, stat.size - suffix.length);
    if (bytes !== suffix.length) return null;
    return { offset: stat.size, ino: stat.ino, dev: stat.dev, suffix };
  });
}

export function readModelJournal(sessionStatePath, sessionId, cursor) {
  if (!cursor) return [];
  const result = withJournal(sessionStatePath, sessionId, (fd, stat) => {
    const offset = cursor.missing ? 0 : cursor.offset;
    if (!cursor.missing && (stat.ino !== cursor.ino || stat.dev !== cursor.dev || stat.size < offset)) return [];
    if (cursor.suffix?.length) {
      const suffix = Buffer.alloc(cursor.suffix.length);
      const bytes = readSync(fd, suffix, 0, suffix.length, offset - suffix.length);
      if (bytes !== suffix.length || !suffix.equals(cursor.suffix)) return [];
    }
    const start = Math.max(offset, stat.size - MAX_EVENT_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    const bytes = readSync(fd, buffer, 0, buffer.length, start);
    let lines = buffer.subarray(0, bytes).toString("utf8").split(/\r?\n/);
    if (start > offset || (offset > 0 && cursor.suffix?.at(-1) !== 10)) lines = lines.slice(1);
    const events = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (["model.call_start", "assistant.usage", ...SUBAGENT_END_EVENTS].includes(event?.type)) events.push(event);
      } catch {
        // Partial writes and malformed records cannot affect prompt execution.
      }
    }
    return events;
  });
  return Array.isArray(result) ? result : [];
}

export function recordModelEvent(report, event) {
  if (!report?.mentionedModels.length || report.overlap) return;
  // agentId identifies subagent events; don't attribute a child call to the
  // session agent. Assistant prose and assistant.message.model are not proof.
  if (["model.call_start", "assistant.usage"].includes(event?.type) && !event.agentId && !event.data?.parentToolCallId && typeof event.data?.model === "string" && event.data.model && event.data.model !== "auto") {
    if (report.recordedModels.size < 50) {
      report.recordedModels.add(event.data.model);
      report.modelEvidence.add(event.type);
    }
  }
  if (SUBAGENT_END_EVENTS.includes(event?.type)) {
    const evidence = completionEvidence(event);
    if (report.delegations.has(evidence.toolCallId)) report.completions.set(evidence.toolCallId, evidence);
  }
}

export function recordModelTool(report, { toolCallId, toolName, rawInput, title = "" }) {
  if (!report?.mentionedModels.length || report.overlap) return;
  const input = rawInput && typeof rawInput === "object" ? rawInput : {};
  const skill = input.skill || input.skillName || String(title || "").match(/^using skill:\s*(.+)$/i)?.[1];
  if (typeof skill === "string" && skill && report.skills.size < 50) report.skills.add(skill);
  const agent = input.agent_type || input.agentType || input.agent_name || input.agentName;
  if (toolCallId && (agent || ["task", "subagent", "delegate"].includes(String(toolName).toLowerCase())) && report.delegations.size < 500) {
    const previous = report.delegations.get(toolCallId);
    report.delegations.set(toolCallId, {
      requestedAgent: typeof agent === "string" && agent ? agent : previous?.requestedAgent || "unspecified subagent",
      requestedModel: typeof input.model === "string" && input.model ? input.model : previous?.requestedModel || "",
    });
  }
}

export function modelReportOutput(report, response = {}) {
  const recordedModels = report.overlap ? [] : [...report.recordedModels];
  const skills = report.overlap ? [] : [...report.skills];
  const delegations = report.overlap ? [] : [...report.delegations].map(([toolCallId, request]) => {
    const evidence = report.completions.get(toolCallId);
    return { toolCallId, ...request, recordedAgent: evidence?.agentName || "",
      firstDispatchedModel: evidence?.firstDispatchedModel || "", failed: evidence?.eventType === "subagent.failed" };
  });
  const quoted = (values) => values.map((value) => `\`${String(value).replaceAll("`", "")}\``).join(", ");
  const lines = [
    "Model report:",
    `Model mentioned in your prompt: ${quoted(report.mentionedModels)}.`,
    `Session agent selected in Copilot: ${quoted([report.sessionAgent])}.`,
    `Session model requested from Copilot: ${quoted([report.requestedSessionModel])}.`,
    recordedModels.length
      ? `Copilot recorded session model calls: ${quoted(recordedModels)}.`
      : "Actual session model unavailable; the requested session model above is not dispatch proof.",
  ];
  if (report.overlap) lines.push("Concurrent prompts prevented attributing runtime events to this request.");
  else {
    if (skills.length) lines.push(`Skill invocation observed: ${quoted(skills)}.`);
    if (!delegations.length) lines.push("No subagent delegation observed for this request.");
    for (const delegation of delegations) {
      lines.push(delegation.recordedAgent
        ? `Subagent recorded by Copilot: ${quoted([delegation.recordedAgent])} (requested agent: ${quoted([delegation.requestedAgent])})${delegation.failed ? "; it failed" : ""}.`
        : `Subagent requested from Copilot: ${quoted([delegation.requestedAgent])}; actual agent unavailable.`);
      lines.push(delegation.firstDispatchedModel
        ? `Recorded first dispatched subagent model: ${quoted([delegation.firstDispatchedModel])}.`
        : `Subagent model requested from Copilot: ${delegation.requestedModel ? quoted([delegation.requestedModel]) : "no override supplied (Copilot chooses or inherits)"}; actual model unavailable.`);
    }
  }
  if (response.error || ["error", "cancelled"].includes(response.result?.stopReason)) lines.push("The request failed or was cancelled; recorded dispatches do not establish task completion.");
  return { text: `\n\n${lines.join("\n")}\n`, meta: {
    activity: "model-request-report", mentionedModels: report.mentionedModels,
    requestedSessionModel: report.requestedSessionModel, sessionAgent: report.sessionAgent,
    recordedModels, skills, delegations, evidence: recordedModels.length ? [...report.modelEvidence].join(", ") : "unavailable",
    overlappingPrompts: report.overlap,
  } };
}
