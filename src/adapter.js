import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  buildGithubLoginCommand,
  listAuthMethods,
  loginFromMethodId,
  parseLoginArgs,
} from "./auth.js";
import {
  listAvailableCommands,
  listCommands,
  parseCommandArgs,
  parseSlashCommand,
} from "./commands.js";
import {
  getSetting,
  listSubagentSettings,
  readSettings,
  setSetting,
  subagentSettingPath,
  unsetSetting,
  writeSettings,
} from "./settings.js";

const DIRECT_COPILOT_COMMANDS = Object.freeze({
  "/init": { args: ["init"] },
  "/skills": { args: ["skill"], defaultArgs: ["list"] },
  "/mcp": { args: ["mcp"], defaultArgs: ["list"] },
  "/plugin": { args: ["plugin"], defaultArgs: ["list"] },
  "/update": { args: ["update"] },
  "/version": { args: ["--version"] },
});

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
          copilotTransports: ["prompt", "stdin", "argv", "command"],
          copilotCommands: listCommands(),
          nativeCommands: [
            "/help",
            "/model",
            "/autopilot",
            "/cwd",
            "/add-dir",
            "/list-dirs",
            "/allow-all",
            "/reset-allowed-tools",
            "/resume",
            "/rename",
            "/session",
            "/new",
            "/clear",
            "/logout",
            "/exit",
            "/settings",
            "/subagents",
          ],
          directCopilotCommands: Object.keys(DIRECT_COPILOT_COMMANDS),
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
      copilotSessionId: params.copilotSessionId || sessionId,
      name: params.name || "",
      allowAll: false,
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
    const sessionId = this.ensureSession(params);
    const session = this.sessions.get(sessionId);
    const prompt = extractPromptText(params);
    const slashCommand = parseSlashCommand(prompt);

    if (slashCommand) {
      const commandResult = await this.handleSlashCommand(session, slashCommand, prompt);
      if (commandResult) {
        return commandResult;
      }
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

  ensureSession(params = {}) {
    if (params.sessionId && this.sessions.has(params.sessionId)) {
      return params.sessionId;
    }

    return this.newSession({
      sessionId: params.sessionId,
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories,
    }).sessionId;
  }

  async handleSlashCommand(session, slashCommand, prompt) {
    if (slashCommand.name === "/login") {
      return this.login(session, slashCommand.rawArgs);
    }

    if (slashCommand.name === "/logout") {
      this.clearAdapterAuth();
      this.sendText(
        session?.id,
        [
          "Adapter-held token authentication has been cleared.",
          "Copilot CLI OAuth logout is an interactive CLI command; use `copilot` and `/logout` directly if you need to revoke a browser/device-flow login.",
        ].join("\n"),
      );
      return this.commandDone(slashCommand, { handledBy: "adapter" });
    }

    if (slashCommand.name === "/help") {
      this.sendText(session?.id, commandHelpText(slashCommand.rawArgs));
      return this.commandDone(slashCommand, { handledBy: "adapter" });
    }

    if (DIRECT_COPILOT_COMMANDS[slashCommand.name]) {
      return this.runDirectCopilotCommand(session, slashCommand);
    }

    const nativeResult = this.handleNativeCommand(session, slashCommand);
    if (nativeResult) {
      return nativeResult;
    }

    if (!slashCommand.supported) {
      this.sendText(
        session?.id,
        `Unknown slash command ${slashCommand.name}. Forwarding it to Copilot in case the installed CLI supports it.`,
      );
    }

    return null;
  }

  handleNativeCommand(session, slashCommand) {
    switch (slashCommand.name) {
      case "/model":
        return this.handleModelCommand(session, slashCommand);
      case "/autopilot":
        return this.handleAutopilotCommand(session, slashCommand);
      case "/cwd":
        return this.handleCwdCommand(session, slashCommand);
      case "/add-dir":
        return this.handleAddDirCommand(session, slashCommand);
      case "/list-dirs":
        return this.handleListDirsCommand(session, slashCommand);
      case "/allow-all":
        session.allowAll = true;
        this.sendText(session?.id, "All Copilot permissions will be requested for subsequent prompts with `--allow-all`.");
        return this.commandDone(slashCommand, { handledBy: "adapter" });
      case "/reset-allowed-tools":
        session.allowAll = false;
        this.sendText(session?.id, "Adapter-level `--allow-all` override reset. Permissions still configured in COPILOT_ARGS remain active.");
        return this.commandDone(slashCommand, { handledBy: "adapter" });
      case "/resume":
        return this.handleResumeCommand(session, slashCommand);
      case "/rename":
        return this.handleRenameCommand(session, slashCommand);
      case "/session":
        this.sendText(session?.id, sessionSummary(session));
        return this.commandDone(slashCommand, { handledBy: "adapter" });
      case "/new":
      case "/clear":
        return this.handleNewCommand(session, slashCommand);
      case "/exit":
        this.sendText(session?.id, "ACP session closed in the adapter.");
        this.sessions.delete(session.id);
        return this.commandDone(slashCommand, { handledBy: "adapter" });
      case "/subagents":
        return this.handleSubagentsCommand(session, slashCommand);
      case "/settings":
        return this.handleSettingsCommand(session, slashCommand);
      default:
        return null;
    }
  }

  handleModelCommand(session, slashCommand) {
    const [modelId] = parseCommandArgs(slashCommand.rawArgs);
    if (!modelId) {
      this.sendText(session?.id, `Current model: ${session.modelId || "auto"}`);
      return this.commandDone(slashCommand, { handledBy: "adapter" });
    }

    session.modelId = modelId;
    this.notify("session/update", {
      sessionId: session.id,
      update: {
        sessionUpdate: "current_model_update",
        currentModelId: session.modelId,
      },
    });
    this.sendText(session?.id, `Model set to ${session.modelId}.`);
    return this.commandDone(slashCommand, { handledBy: "adapter" });
  }

  handleAutopilotCommand(session, slashCommand) {
    const [value] = parseCommandArgs(slashCommand.rawArgs);
    const normalized = String(value || "").toLowerCase();
    if (["off", "false", "0", "agent", "interactive"].includes(normalized)) {
      session.modeId = "agent";
    } else if (["on", "true", "1", "autopilot", ""].includes(normalized)) {
      session.modeId = session.modeId === "autopilot" && !normalized ? "agent" : "autopilot";
    } else {
      session.modeId = "autopilot";
    }
    this.notify("session/update", {
      sessionId: session.id,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: session.modeId,
      },
    });
    this.sendText(session?.id, `Mode set to ${session.modeId}.`);
    return this.commandDone(slashCommand, { handledBy: "adapter" });
  }

  handleCwdCommand(session, slashCommand) {
    const [cwdArg] = parseCommandArgs(slashCommand.rawArgs);
    if (!cwdArg) {
      this.sendText(session?.id, `Current working directory: ${session.cwd}`);
      return this.commandDone(slashCommand, { handledBy: "adapter" });
    }

    session.cwd = resolve(session.cwd || this.config.cwd, cwdArg);
    this.sendText(session?.id, `Working directory set to ${session.cwd}.`);
    return this.commandDone(slashCommand, { handledBy: "adapter" });
  }

  handleAddDirCommand(session, slashCommand) {
    const [dirArg] = parseCommandArgs(slashCommand.rawArgs);
    if (!dirArg) {
      this.sendText(session?.id, "Usage: `/add-dir <directory>`");
      return this.commandDone(slashCommand, { handledBy: "adapter", error: "missing directory" });
    }

    const directory = resolve(session.cwd || this.config.cwd, dirArg);
    if (!session.additionalDirectories.includes(directory)) {
      session.additionalDirectories.push(directory);
    }
    this.sendText(session?.id, `Added allowed directory ${directory}.`);
    return this.commandDone(slashCommand, { handledBy: "adapter" });
  }

  handleListDirsCommand(session, slashCommand) {
    this.sendText(
      session?.id,
      [
        `Working directory: ${session.cwd}`,
        "Additional directories:",
        ...(session.additionalDirectories.length
          ? session.additionalDirectories.map((directory) => `- ${directory}`)
          : ["- none"]),
      ].join("\n"),
    );
    return this.commandDone(slashCommand, { handledBy: "adapter" });
  }

  handleResumeCommand(session, slashCommand) {
    const [target] = parseCommandArgs(slashCommand.rawArgs);
    if (!target) {
      this.sendText(
        session?.id,
        [
          "Usage: `/resume <session-id-or-task-id>`",
          `Current Copilot session id: ${session.copilotSessionId}`,
          "The interactive session picker is not available over ACP stdio.",
        ].join("\n"),
      );
      return this.commandDone(slashCommand, { handledBy: "adapter", error: "missing session id" });
    }

    session.copilotSessionId = target;
    this.sendText(session?.id, `Subsequent prompts will use Copilot session ${target}.`);
    return this.commandDone(slashCommand, { handledBy: "adapter" });
  }

  handleRenameCommand(session, slashCommand) {
    const name = slashCommand.rawArgs.trim();
    if (!name) {
      this.sendText(session?.id, `Current session name: ${session.name || "(unnamed)"}`);
      return this.commandDone(slashCommand, { handledBy: "adapter" });
    }

    session.name = name;
    this.sendText(session?.id, `Adapter session renamed to ${session.name}.`);
    return this.commandDone(slashCommand, { handledBy: "adapter" });
  }

  handleNewCommand(session, slashCommand) {
    session.copilotSessionId = randomUUID();
    session.createdAt = new Date().toISOString();
    this.sendText(session?.id, `Started a fresh Copilot conversation: ${session.copilotSessionId}`);
    return this.commandDone(slashCommand, { handledBy: "adapter" });
  }

  handleSubagentsCommand(session, slashCommand) {
    const args = parseCommandArgs(slashCommand.rawArgs);
    const [first] = args;

    if (!first || first === "list") {
      this.sendText(session?.id, subagentsSummary(readSettings(this.config.copilotSettingsPath), this.config));
      return this.commandDone(slashCommand, { handledBy: "adapter" });
    }

    if (["help", "--help", "-h"].includes(first)) {
      this.sendText(session?.id, subagentsHelpText(this.config));
      return this.commandDone(slashCommand, { handledBy: "adapter" });
    }

    if (["unset", "reset", "inherit"].includes(first)) {
      const [agentName] = args.slice(1);
      if (!agentName) {
        this.sendText(session?.id, "Usage: `/subagents unset <agent-name>`");
        return this.commandDone(slashCommand, { handledBy: "adapter", error: "missing agent" }, "error");
      }
      return this.updateSubagentSetting(session, slashCommand, agentName, null);
    }

    const [agentName, model, effortLevel = "inherit", contextTier = "inherit"] =
      first === "set" ? args.slice(1) : args;

    if (!agentName) {
      this.sendText(session?.id, subagentsHelpText(this.config));
      return this.commandDone(slashCommand, { handledBy: "adapter", error: "missing agent" }, "error");
    }

    if (!model) {
      const settings = readSettings(this.config.copilotSettingsPath);
      const value = getSetting(settings, subagentSettingPath(agentName));
      this.sendText(session?.id, subagentDetail(agentName, value, this.config));
      return this.commandDone(slashCommand, { handledBy: "adapter" });
    }

    return this.updateSubagentSetting(session, slashCommand, agentName, {
      model,
      effortLevel,
      contextTier,
    });
  }

  handleSettingsCommand(session, slashCommand) {
    const args = parseCommandArgs(slashCommand.rawArgs);
    const [key, ...valueParts] = args;

    if (!key) {
      this.sendText(
        session?.id,
        [
          "Adapter settings support:",
          "- `/settings subagents.agents.<agent-name>`",
          "- `/settings subagents.agents.<agent-name> <model> [effortLevel] [contextTier]`",
          "- `/settings unset subagents.agents.<agent-name>`",
          `Settings file: ${this.config.copilotSettingsPath}`,
        ].join("\n"),
      );
      return this.commandDone(slashCommand, { handledBy: "adapter" });
    }

    if (key === "unset") {
      const [targetKey] = valueParts;
      if (!isSupportedAdapterSetting(targetKey)) {
        this.sendText(session?.id, `Adapter can only unset subagent settings, for example \`/settings unset subagents.agents.explore\`.`);
        return this.commandDone(slashCommand, { handledBy: "adapter", error: "unsupported setting" }, "error");
      }
      return this.updateSetting(session, slashCommand, targetKey, undefined);
    }

    if (!isSupportedAdapterSetting(key)) {
      this.sendText(
        session?.id,
        [
          `The ACP adapter does not implement native handling for setting \`${key}\`.`,
          "Forwarding `/settings` through non-interactive Copilot prompt mode causes the model to explain the command instead of executing the CLI UI.",
          "Supported native setting path: `subagents.agents.<agent-name>`.",
        ].join("\n"),
      );
      return this.commandDone(slashCommand, { handledBy: "adapter", error: "unsupported setting" }, "error");
    }

    if (!valueParts.length) {
      const settings = readSettings(this.config.copilotSettingsPath);
      const value = getSetting(settings, key);
      this.sendText(session?.id, settingDetail(key, value, this.config));
      return this.commandDone(slashCommand, { handledBy: "adapter" });
    }

    const [model, effortLevel = "inherit", contextTier = "inherit"] = valueParts;
    return this.updateSetting(session, slashCommand, key, { model, effortLevel, contextTier });
  }

  updateSubagentSetting(session, slashCommand, agentName, value) {
    if (!isValidSubagentName(agentName)) {
      this.sendText(session?.id, `Invalid subagent name: ${agentName}`);
      return this.commandDone(slashCommand, { handledBy: "adapter", error: "invalid agent" }, "error");
    }
    return this.updateSetting(session, slashCommand, subagentSettingPath(agentName), value);
  }

  updateSetting(session, slashCommand, key, value) {
    const settings = readSettings(this.config.copilotSettingsPath);
    if (value === undefined || value === null) {
      unsetSetting(settings, key);
      writeSettings(this.config.copilotSettingsPath, settings);
      this.sendText(session?.id, `Unset ${key}. Copilot will inherit the parent session defaults.`);
      return this.commandDone(slashCommand, { handledBy: "adapter", setting: key });
    }

    setSetting(settings, key, value);
    writeSettings(this.config.copilotSettingsPath, settings);
    this.sendText(
      session?.id,
      [
        `Set ${key}:`,
        `- model: ${value.model}`,
        `- effortLevel: ${value.effortLevel}`,
        `- contextTier: ${value.contextTier}`,
        `Settings file: ${this.config.copilotSettingsPath}`,
      ].join("\n"),
    );
    return this.commandDone(slashCommand, { handledBy: "adapter", setting: key });
  }

  async runDirectCopilotCommand(session, slashCommand) {
    const command = DIRECT_COPILOT_COMMANDS[slashCommand.name];
    const rawArgs = parseCommandArgs(slashCommand.rawArgs);
    const args = [
      ...command.args,
      ...(rawArgs.length ? rawArgs : command.defaultArgs || []),
    ];
    let streamed = false;
    const result = await this.runner.runCommand(this.config.copilotCommand, args, {
      cwd: session?.cwd || this.config.cwd,
      env: {
        COPILOT_AUTO_UPDATE: "false",
        ...this.globalEnv,
        ...(session?.env || {}),
      },
      forceTty: Boolean(this.config.forceTtyDirectCommands),
      timeoutMs: this.config.requestTimeoutMs,
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

    return this.commandDone(slashCommand, {
      handledBy: "copilot-command",
      args,
      exitCode: result.exitCode,
      signal: result.signal,
      error: result.error,
    }, result.ok ? "end_turn" : "error");
  }

  commandDone(command, meta = {}, stopReason = "end_turn") {
    return {
      stopReason,
      _meta: {
        command,
        ...meta,
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

function commandHelpText(rawArgs) {
  const [topic] = parseCommandArgs(rawArgs);
  if (topic) {
    const normalized = topic.startsWith("/") ? topic : `/${topic}`;
    const command = listCommands().find((entry) => entry.name === normalized);
    const available = listAvailableCommands().find(
      (entry) => entry.name === normalized.slice(1),
    );

    if (command) {
      return [
        `${command.name} (${command.group})`,
        available?.description || "Copilot slash command.",
        commandHelpRouting(command.name),
      ].join("\n");
    }

    return `No adapter command help found for ${topic}. Use /help to list supported commands.`;
  }

  const lines = ["Copilot ACP adapter commands:", ""];
  for (const command of listAvailableCommands()) {
    lines.push(`/${command.name} - ${command.description}`);
  }
  lines.push("");
  lines.push("Management commands such as /skills, /mcp, /plugin, /init, /update, and /version run direct Copilot CLI subcommands.");
  lines.push("Interactive configuration commands such as /subagents are handled natively by the adapter where Copilot exposes settings.");
  lines.push("Agent workflow commands are forwarded to Copilot prompt mode with this ACP session's Copilot session id.");
  return lines.join("\n");
}

function commandHelpRouting(name) {
  if (DIRECT_COPILOT_COMMANDS[name]) {
    return "Handled by direct Copilot CLI subcommand routing.";
  }
  if (
    [
      "/help",
      "/model",
      "/autopilot",
      "/cwd",
      "/add-dir",
      "/list-dirs",
      "/allow-all",
      "/reset-allowed-tools",
      "/resume",
      "/rename",
      "/session",
      "/new",
      "/clear",
      "/login",
      "/logout",
      "/exit",
      "/settings",
      "/subagents",
    ].includes(name)
  ) {
    return "Handled by the ACP adapter.";
  }
  return "Forwarded to Copilot prompt mode.";
}

function subagentsSummary(settings, config) {
  const configured = Object.entries(listSubagentSettings(settings));
  const lines = [
    "Copilot subagent model settings:",
    `Settings file: ${config.copilotSettingsPath}`,
    "",
  ];

  if (!configured.length) {
    lines.push("No per-subagent settings are configured. Subagents inherit the parent session model, effort level, and context tier.");
    lines.push("");
    lines.push("Common agent names: explore, general-purpose, code-review");
  } else {
    for (const [agentName, value] of configured) {
      lines.push(formatSubagentSetting(agentName, value));
    }
  }

  lines.push("");
  lines.push("Usage:");
  lines.push("- `/subagents <agent-name>`");
  lines.push("- `/subagents set <agent-name> <model> [effortLevel] [contextTier]`");
  lines.push("- `/subagents unset <agent-name>`");
  return lines.join("\n");
}

function subagentDetail(agentName, value, config) {
  if (!value) {
    return [
      `${subagentSettingPath(agentName)} is not configured.`,
      "Copilot will inherit the parent session defaults.",
      `Settings file: ${config.copilotSettingsPath}`,
    ].join("\n");
  }
  return [formatSubagentSetting(agentName, value), `Settings file: ${config.copilotSettingsPath}`].join("\n");
}

function settingDetail(key, value, config) {
  if (value === undefined) {
    return [
      `${key} is not configured.`,
      `Settings file: ${config.copilotSettingsPath}`,
    ].join("\n");
  }
  return [
    `${key}:`,
    JSON.stringify(value, null, 2),
    `Settings file: ${config.copilotSettingsPath}`,
  ].join("\n");
}

function subagentsHelpText(config) {
  return [
    "Configure default and per-agent subagent models without opening Copilot's interactive UI.",
    "",
    "Usage:",
    "- `/subagents`",
    "- `/subagents <agent-name>`",
    "- `/subagents set <agent-name> <model> [effortLevel] [contextTier]`",
    "- `/subagents <agent-name> <model> [effortLevel] [contextTier]`",
    "- `/subagents unset <agent-name>`",
    "",
    "Each omitted effortLevel or contextTier is stored as `inherit`.",
    `Settings file: ${config.copilotSettingsPath}`,
  ].join("\n");
}

function formatSubagentSetting(agentName, value) {
  return [
    `${agentName}:`,
    `- model: ${value?.model || "inherit"}`,
    `- effortLevel: ${value?.effortLevel || "inherit"}`,
    `- contextTier: ${value?.contextTier || "inherit"}`,
  ].join("\n");
}

function isSupportedAdapterSetting(key) {
  return /^subagents\.agents\.[A-Za-z0-9_-]+$/.test(String(key || ""));
}

function isValidSubagentName(agentName) {
  return /^[A-Za-z0-9_-]+$/.test(String(agentName || ""));
}

function sessionSummary(session) {
  return [
    "ACP adapter session:",
    `- ACP session id: ${session.id}`,
    `- Copilot session id: ${session.copilotSessionId}`,
    `- Name: ${session.name || "(unnamed)"}`,
    `- CWD: ${session.cwd}`,
    `- Model: ${session.modelId || "auto"}`,
    `- Mode: ${session.modeId || "agent"}`,
    `- Allow all override: ${session.allowAll ? "on" : "off"}`,
    `- Additional directories: ${
      session.additionalDirectories.length ? session.additionalDirectories.join(", ") : "none"
    }`,
    `- Created: ${session.createdAt}`,
  ].join("\n");
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
  const sessionStripped = stripOption(modeStripped, "--session-id");
  const addDirStripped = stripOption(sessionStripped, "--add-dir");
  const result = stripFlag(addDirStripped, "--continue");

  if (session?.modelId && session.modelId !== "auto") {
    result.push("--model", session.modelId);
  }

  if (session?.modeId && session.modeId !== "agent") {
    result.push("--mode", modeCliValue(session.modeId));
  }

  if (session?.allowAll) {
    result.push("--allow-all");
  }

  for (const directory of session?.additionalDirectories || []) {
    result.push("--add-dir", directory);
  }

  if (session?.copilotSessionId) {
    result.push("--session-id", session.copilotSessionId);
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

function stripFlag(args, option) {
  return args.filter((arg) => arg !== option && !arg.startsWith(`${option}=`));
}
