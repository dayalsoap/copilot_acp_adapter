export function createCopilotJsonEventForwarder({
  sendAgentMessage,
  sendThought,
  sendToolCall,
  sendToolCallUpdate,
}) {
  return new CopilotJsonEventForwarder({
    sendAgentMessage,
    sendThought,
    sendToolCall,
    sendToolCallUpdate,
  });
}

class CopilotJsonEventForwarder {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.buffer = "";
    this.sawJson = false;
    this.messageBuffers = new Map();
    this.toolInputBuffers = new Map();
    this.tools = new Map();
    this.lastStatus = "";
  }

  write(chunk) {
    this.buffer += String(chunk || "");
    let lineEnd;
    while ((lineEnd = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, lineEnd).trim();
      this.buffer = this.buffer.slice(lineEnd + 1);
      if (line) {
        this.handleLine(line);
      }
    }
  }

  end() {
    const line = this.buffer.trim();
    this.buffer = "";
    if (line) {
      this.handleLine(line);
    }
  }

  handleLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (!event || typeof event.type !== "string") {
      return;
    }

    this.sawJson = true;
    this.handleEvent(event);
  }

  handleEvent(event) {
    switch (event.type) {
      case "session.auto_mode_resolved":
        this.emitStatus(autoModeStatus(event.data));
        break;
      case "model.call_start":
        this.emitStatus(event.data?.model ? `Calling model \`${event.data.model}\`.` : "");
        break;
      case "assistant.reasoning":
        if (event.data?.content) {
          this.callbacks.sendThought(event.data.content);
        }
        break;
      case "assistant.message_delta":
        this.appendMessageDelta(event.data);
        break;
      case "assistant.message":
        this.flushMessage(event.data);
        break;
      case "assistant.tool_call_delta":
        this.appendToolCallDelta(event.data);
        break;
      case "tool.execution_start":
        this.emitToolStart(event.data);
        break;
      case "tool.execution_partial_result":
        this.emitToolPartial(event.data);
        break;
      case "tool.execution_complete":
        this.emitToolComplete(event.data);
        break;
      default:
        break;
    }
  }

  emitStatus(text) {
    if (!text || text === this.lastStatus) {
      return;
    }
    this.lastStatus = text;
    this.callbacks.sendThought(`${text}\n`);
  }

  appendMessageDelta(data = {}) {
    if (!data.messageId || !data.deltaContent) {
      return;
    }
    const current = this.messageBuffers.get(data.messageId) || "";
    this.messageBuffers.set(data.messageId, current + data.deltaContent);
  }

  flushMessage(data = {}) {
    const buffered = this.messageBuffers.get(data.messageId) || "";
    const content = data.content || buffered;
    this.messageBuffers.delete(data.messageId);

    if (Array.isArray(data.toolRequests) && data.toolRequests.length) {
      if (content) {
        this.callbacks.sendThought(`${content}\n`);
      }
      for (const request of data.toolRequests) {
        this.emitToolCallFromRequest(request);
      }
      return;
    }

    if (content) {
      this.callbacks.sendAgentMessage(content);
    }
  }

  appendToolCallDelta(data = {}) {
    if (!data.toolCallId || !data.inputDelta) {
      return;
    }

    const current = this.toolInputBuffers.get(data.toolCallId) || "";
    const input = current + data.inputDelta;
    this.toolInputBuffers.set(data.toolCallId, input);
    const parsed = parseJsonObject(input);
    if (!parsed) {
      this.rememberTool(data.toolCallId, {
        title: toolTitle(data.toolName),
        kind: toolKind(data.toolName),
      });
      return;
    }

    const tool = this.rememberTool(data.toolCallId, {
      title: toolTitle(data.toolName, parsed),
      kind: toolKind(data.toolName),
      rawInput: parsed,
    });

    if (!tool.started) {
      this.callbacks.sendToolCall({
        toolCallId: data.toolCallId,
        title: tool.title,
        kind: tool.kind,
        status: "in_progress",
        rawInput: tool.rawInput,
      });
      tool.started = true;
    }
  }

  emitToolCallFromRequest(request = {}) {
    const rawInput = request.arguments || {};
    const tool = this.rememberTool(request.toolCallId, {
      title: request.intentionSummary || toolTitle(request.name, rawInput),
      kind: toolKind(request.name),
      rawInput,
    });
    if (tool.started) {
      return;
    }
    this.callbacks.sendToolCall({
      toolCallId: request.toolCallId,
      title: tool.title,
      kind: tool.kind,
      status: "in_progress",
      rawInput: tool.rawInput,
    });
    tool.started = true;
  }

  emitToolStart(data = {}) {
    const rawInput = data.arguments || {};
    const tool = this.rememberTool(data.toolCallId, {
      title: toolTitle(data.toolName, rawInput),
      kind: toolKind(data.toolName),
      rawInput,
    });
    if (tool.started) {
      return;
    }
    this.callbacks.sendToolCall({
      toolCallId: data.toolCallId,
      title: tool.title,
      kind: tool.kind,
      status: "in_progress",
      rawInput: tool.rawInput,
    });
    tool.started = true;
  }

  emitToolPartial(data = {}) {
    const tool = this.rememberTool(data.toolCallId, {});
    const output = data.partialOutput || "";
    if (!output || output === tool.lastPartialOutput) {
      return;
    }
    tool.lastPartialOutput = output;
    this.callbacks.sendToolCallUpdate({
      toolCallId: data.toolCallId,
      title: tool.title,
      kind: tool.kind,
      status: "in_progress",
      rawInput: tool.rawInput,
      output,
    });
  }

  emitToolComplete(data = {}) {
    const tool = this.rememberTool(data.toolCallId, {});
    const output = toolResultText(data.result);
    this.callbacks.sendToolCallUpdate({
      toolCallId: data.toolCallId,
      title: tool.title,
      kind: tool.kind,
      status: data.success === false ? "failed" : "completed",
      rawInput: tool.rawInput,
      output,
    });
  }

  rememberTool(toolCallId, fields) {
    const existing = this.tools.get(toolCallId) || {
      title: "Tool",
      kind: "other",
      rawInput: {},
      started: false,
      lastPartialOutput: "",
    };
    const next = {
      ...existing,
      ...Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined && value !== null),
      ),
    };
    this.tools.set(toolCallId, next);
    return next;
  }
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function autoModeStatus(data = {}) {
  if (!data.chosenModel) {
    return "";
  }
  const effort = data.reasoningBucket ? `, ${data.reasoningBucket} reasoning` : "";
  return `Auto selected model \`${data.chosenModel}\`${effort}.`;
}

function toolKind(name) {
  const normalized = String(name || "").toLowerCase();
  if (["bash", "shell", "terminal", "run_command"].includes(normalized)) {
    return "execute";
  }
  if (["read", "read_file"].includes(normalized)) {
    return "read";
  }
  if (["edit", "write", "write_file", "apply_patch"].includes(normalized)) {
    return "edit";
  }
  return "other";
}

function toolTitle(name, rawInput = {}) {
  const input = rawInput && typeof rawInput === "object" ? rawInput : {};
  if (input.description) {
    return input.description;
  }
  if (input.command) {
    return input.command;
  }
  return name ? String(name) : "Tool";
}

function toolResultText(result = {}) {
  if (typeof result.content === "string") {
    return result.content;
  }
  if (typeof result.detailedContent === "string") {
    return result.detailedContent;
  }
  if (Array.isArray(result.contents)) {
    return result.contents
      .map((item) => item.outputPreview || item.text || "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
