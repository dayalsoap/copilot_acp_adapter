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
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd: params.cwd || this.config.cwd,
      additionalDirectories: params.additionalDirectories || [],
      env: {},
      createdAt: new Date().toISOString(),
    });
    this.sendAvailableCommands(sessionId);
    return { sessionId };
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
