import { randomUUID } from "node:crypto";
import {
  buildGithubLoginCommand,
  listAuthMethods,
  loginFromMethodId,
  parseLoginArgs,
} from "./auth.js";
import {
  listAvailableCommands,
  listCommands,
  parseSlashCommand,
} from "./commands.js";

export class CopilotAcpAdapter {
  constructor({ config, runner, notify = () => {} }) {
    this.config = config;
    this.runner = runner;
    this.notify = notify;
    this.sessions = new Map();
    this.globalEnv = {};
  }

  async handle(method, params = {}) {
    switch (method) {
      case "initialize":
        return this.initialize();
      case "authenticate":
        return this.authenticate(params);
      case "logout":
        return this.logout();
      case "agent/commands":
      case "commands/list":
      case "_commands/list":
        return { commands: listCommands() };
      case "newSession":
      case "session/new":
        return this.newSession(params);
      case "session/close":
        return this.closeSession(params);
      case "session/set_model":
        return this.setModel(params);
      case "session/set_mode":
        return this.setMode(params);
      case "prompt":
      case "session/prompt":
        return this.prompt(params);
      case "cancel":
      case "session/cancel":
        return { cancelled: false, reason: "Per-request process cancellation is not active." };
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  initialize() {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {
          embeddedContext: true,
        },
        auth: {
          logout: {},
        },
        sessionCapabilities: {
          close: {},
          additionalDirectories: {},
        },
        _meta: {
          slashCommandPassthrough: true,
          copilotTransports: ["stdin", "argv", "command"],
          copilotCommands: listCommands(),
        },
      },
      agentInfo: {
        name: "copilot-acp-adapter",
        title: "Copilot ACP Adapter",
        version: "0.1.0",
      },
      authMethods: listAuthMethods(this.config),
    };
  }

  newSession(params = {}) {
    const sessionId = params.sessionId || randomUUID();
    const session = {
      id: sessionId,
      cwd: params.cwd || this.config.cwd,
      additionalDirectories: params.additionalDirectories || [],
      env: {},
      modelId: this.config.copilotModel || "auto",
      modeId: normalizeModeId(this.config.copilotMode || "agent"),
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, session);
    this.sendAvailableCommands(sessionId);
    return {
      sessionId,
      models: sessionModels(session, this.config),
      modes: sessionModes(session),
    };
  }

  closeSession(params = {}) {
    if (params.sessionId) {
      this.sessions.delete(params.sessionId);
    }
    return {};
  }

  async prompt(params = {}) {
    const sessionId = params.sessionId || this.newSession({ cwd: params.cwd }).sessionId;
    const session = this.sessions.get(sessionId);
    const prompt = extractPromptText(params);
    const slashCommand = parseSlashCommand(prompt);

    if (slashCommand?.name === "/login") {
      return this.login(session, slashCommand.rawArgs);
    }

    if (slashCommand?.name === "/logout") {
      this.clearAdapterAuth();
    }

    const result = await this.runner.runPrompt(prompt, {
      cwd: session?.cwd || this.config.cwd,
      env: { ...this.globalEnv, ...(session?.env || {}) },
      copilotArgs: buildPromptArgs(this.config.copilotArgs || [], session),
    });

    this.sendOutput(sessionId, result);

    return {
      stopReason: result.ok ? "end_turn" : "error",
      _meta: {
        command: slashCommand,
        exitCode: result.exitCode,
        signal: result.signal,
        error: result.error,
      },
    };
  }

  setModel(params = {}) {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.modelId = params.modelId || session.modelId;
    }
    return {};
  }

  setMode(params = {}) {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.modeId = normalizeModeId(params.modeId || session.modeId);
      this.notify("session/update", {
        sessionId: session.id,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: session.modeId,
        },
      });
    }
    return {};
  }

  async authenticate(params = {}) {
    const login = loginFromMethodId(params.methodId, this.config);
    const plan = buildGithubLoginCommand(login, this.config);

    if (!plan.ok) {
      throw Object.assign(new Error(plan.message), { code: -32001 });
    }

    if (plan.type === "api-key") {
      this.globalEnv = { ...this.globalEnv, ...plan.env };
      return {};
    }

    const result = await this.runner.runCommand(plan.command, plan.args, {
      cwd: this.config.cwd,
      env: plan.env,
      timeoutMs: 0,
    });

    if (!result.ok) {
      throw Object.assign(new Error(result.stderr || result.error || "Authentication failed"), {
        code: -32001,
      });
    }

    return {};
  }

  async login(session, rawArgs) {
    const login = parseLoginArgs(rawArgs, this.config);
    const plan = buildGithubLoginCommand(login, this.config);

    if (!plan.ok) {
      this.sendText(session?.id, plan.message);
      return {
        stopReason: "error",
        _meta: { error: plan.message },
      };
    }

    if (plan.type === "api-key") {
      if (session) {
        session.env = { ...(session.env || {}), ...plan.env };
      } else {
        this.globalEnv = { ...this.globalEnv, ...plan.env };
      }
      this.sendText(session?.id, plan.message);
      return {
        stopReason: "end_turn",
        _meta: { auth: "api-key" },
      };
    }

    if (plan.type === "choose") {
      this.sendText(session?.id, plan.message);
      return {
        stopReason: "end_turn",
        _meta: { auth: "choose" },
      };
    }

    this.sendText(session?.id, plan.message);
    let streamed = false;
    const result = await this.runner.runCommand(plan.command, plan.args, {
      cwd: session?.cwd || this.config.cwd,
      env: plan.env,
      timeoutMs: 0,
      onStdout: (text) => {
        streamed = true;
        this.sendText(session?.id, text);
      },
      onStderr: (text) => {
        streamed = true;
        this.sendText(session?.id, text, "agent_message_chunk", { stream: "stderr" });
      },
    });
    if (!streamed) {
      this.sendOutput(session?.id, result);
    }

    return {
      stopReason: result.ok ? "end_turn" : "error",
      _meta: {
        exitCode: result.exitCode,
        error: result.error,
      },
    };
  }

  async logout() {
    this.clearAdapterAuth();
    return {};
  }

  clearAdapterAuth() {
    this.globalEnv = {};
    for (const session of this.sessions.values()) {
      session.env = {};
    }
  }

  sendAvailableCommands(sessionId) {
    this.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: listAvailableCommands(),
      },
    });
  }

  sendOutput(sessionId, result) {
    if (result.stdout) {
      this.sendText(sessionId, result.stdout, "agent_message_chunk");
    }
    if (result.stderr) {
      this.sendText(sessionId, result.stderr, "agent_message_chunk", { stream: "stderr" });
    }
  }

  sendText(sessionId, text, sessionUpdate = "agent_message_chunk", meta = {}) {
    if (!sessionId || !text) {
      return;
    }
    this.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate,
        messageId: randomUUID(),
        content: {
          type: "text",
          text,
        },
        _meta: meta,
      },
    });
  }
}

function extractPromptText(params) {
  if (Array.isArray(params.prompt)) {
    return params.prompt
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("");
  }
  if (typeof params.prompt === "string") {
    return params.prompt;
  }
  if (typeof params.text === "string") {
    return params.text;
  }
  if (Array.isArray(params.content)) {
    return params.content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("");
  }
  return "";
}

function sessionModels(session, config) {
  const currentModelId = session.modelId || "auto";
  return {
    currentModelId,
    availableModels: [
      {
        modelId: currentModelId,
        name: config.copilotModelName || modelDisplayName(currentModelId),
        description:
          currentModelId === "auto"
            ? "Copilot chooses the model automatically"
            : "Configured Copilot model",
      },
    ],
  };
}

function sessionModes(session) {
  return {
    currentModeId: session.modeId || "agent",
    availableModes: [
      {
        id: "agent",
        name: "Agent",
        description: "Default Copilot agent mode",
      },
      {
        id: "plan",
        name: "Plan",
        description: "Plan before making changes",
      },
      {
        id: "autopilot",
        name: "Autopilot",
        description: "Continue autonomously where possible",
      },
    ],
  };
}

function modelDisplayName(modelId) {
  if (!modelId || modelId === "auto") {
    return "Auto";
  }

  return modelId
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

function normalizeModeId(modeId) {
  if (modeId === "interactive" || !modeId) {
    return "agent";
  }
  return modeId;
}

function modeCliValue(modeId) {
  if (modeId === "agent") {
    return "interactive";
  }
  return modeId;
}

function buildPromptArgs(baseArgs, session) {
  const args = stripOption(baseArgs, "--model");
  const modeStripped = stripOption(args, "--mode");
  const result = [...modeStripped];

  if (session?.modelId && session.modelId !== "auto") {
    result.push("--model", session.modelId);
  }

  if (session?.modeId && session.modeId !== "agent") {
    result.push("--mode", modeCliValue(session.modeId));
  }

  return result;
}

function stripOption(args, option) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === option) {
      index += 1;
      continue;
    }
    if (arg.startsWith(`${option}=`)) {
      continue;
    }
    result.push(arg);
  }
  return result;
}
