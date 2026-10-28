import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { DEFAULT_CHANGELOG_URL, fetchCopilotChangelog, selectChangelog } from "./changelog.js";
import {
  buildGithubLoginCommand,
  listAuthMethods,
  loginFromMethodId,
  parseLoginArgs,
} from "./auth.js";
import {
  listAvailableCommands,
  parseCommandArgs,
  parseSlashCommand,
} from "./commands.js";
import { discoverProjectAgents } from "./project-agents.js";
import {
  getSetting,
  listSubagentSettings,
  readSettings,
  setSetting,
  subagentSettingPath,
  unsetSetting,
  writeSettings,
} from "./settings.js";
import { completionEvidence, readSubagentCompletions } from "./subagent-reports.js";
import { mentionedModels, modelReportOutput, readModelJournal, recordModelEvent, recordModelTool, snapshotModelJournal } from "./model-reports.js";

const MAX_TRACKED_SUBAGENTS = 500;

// Only helpers implemented by this adapter belong beside native commands.
const NATIVE_HELPER_COMMANDS = new Set([
  "/login", "/logout", "/help", "/changelog", "/diff", "/settings",
  "/subagents", "/experimental", "/keep-alive", "/exit",
  "/version", "/update",
]);

const DIRECT_COPILOT_COMMANDS = Object.freeze({
  "/update": { args: ["update"] },
  "/version": { args: ["--version"] },
});

export class CopilotAcpAdapter {
  constructor({
    config,
    runner,
    notify = () => {},
    fetchImpl = globalThis.fetch,
    restartBackend = null,
  }) {
    this.config = config;
    this.runner = runner;
    this.notify = notify;
    this.restartBackend = restartBackend;
    this.sessions = new Map();
    this.globalEnv = {};
    this.fetchImpl = fetchImpl;
    this.changelogPromise = null;
    this.activeOperations = new Map();
    // Native ACP tells us what was requested in rawInput, while the session
    // journal is the only observed source for firstDispatchedModel.
    this.nativeSubagentStarts = new Map();
    this.nativeCommands = new Map();
    this.modelReportTurns = new Map();
  }

  async handle(method, params = {}) {
    // Everything else is proxied to native Copilot ACP; see shouldHandleLocally.
    switch (method) {
      case "authenticate":
        return this.authenticate(params);
      case "logout":
        return this.logout();
      case "agent/commands":
      case "commands/list":
      case "_commands/list":
        return { commands: this.availableNativeCommands(params.sessionId) };
      case "prompt":
      case "session/prompt":
        return this.prompt(params);
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  shouldHandleLocally(method, params = {}) {
    switch (method) {
      case "authenticate":
        return ["github.com", "github-enterprise", "api-key"].includes(params.methodId);
      case "logout":
      case "agent/commands":
      case "commands/list":
      case "_commands/list":
        return true;
      case "prompt":
      case "session/prompt":
        return this.shouldHandlePromptLocally(params);
      default:
        return false;
    }
  }

  shouldHandlePromptLocally(params = {}) {
    const slashCommand = parseSlashCommand(extractPromptText(params));
    if (!slashCommand || this.isChangelogSummary(params)) {
      return false;
    }

    const commands = this.nativeCommands.get(params.sessionId);
    const advertised = this.nativeAdvertises(params.sessionId, slashCommand.name);
    // Native wins a name collision once it has advertised the command.
    if (NATIVE_HELPER_COMMANDS.has(slashCommand.name)) return !advertised;
    // ACP treats unsupported slash commands as model prompts. Once native
    // discovery has arrived, reject those instead of pretending to run them.
    return Boolean(commands && !advertised);
  }

  nativeAdvertises(sessionId, commandName) {
    return Boolean(this.nativeCommands.get(sessionId)?.some((command) => `/${command.name}` === commandName));
  }

  enhanceInitialize(nativeResult = {}) {
    const local = this.initialize();
    return {
      ...nativeResult,
      protocolVersion: nativeResult.protocolVersion ?? local.protocolVersion,
      agentCapabilities: {
        ...(nativeResult.agentCapabilities || {}),
        auth: {
          ...(nativeResult.agentCapabilities?.auth || {}),
          ...(local.agentCapabilities?.auth || {}),
        },
        _meta: {
          ...(nativeResult.agentCapabilities?._meta || {}),
          backend: "native-acp-proxy",
          commandDiscovery: "available_commands_update",
        },
      },
      agentInfo: {
        ...(nativeResult.agentInfo || {}),
        name: "copilot-acp-adapter",
        title: nativeResult.agentInfo?.title || "Copilot ACP Adapter",
        _meta: {
          nativeAgentInfo: nativeResult.agentInfo,
        },
      },
      authMethods: mergeAuthMethods(nativeResult.authMethods, local.authMethods),
    };
  }

  async adoptNativeSession(params = {}, nativeResult = {}) {
    const sessionId = nativeResult.sessionId || params.sessionId || randomUUID();
    const session = {
      ...this.sessionRecord(sessionId, nativeResult.cwd || params.cwd),
      modelId:
        nativeResult.models?.currentModelId ||
        configOptionCurrentValue(nativeResult.configOptions, "model") ||
        "auto",
      nativeConfigOptions: nativeResult.configOptions,
    };
    this.sessions.set(sessionId, session);
    this.scheduleAvailableCommands(sessionId);
    return this.enhanceSessionStartResult(session, nativeResult);
  }

  sessionRecord(sessionId, cwd) {
    return {
      id: sessionId,
      cwd: cwd || this.config.cwd,
      env: {},
      modelId: "auto",
      copilotSessionId: sessionId,
    };
  }

  // Only adapter helpers reach this; every other prompt is proxied to native.
  async prompt(params = {}) {
    // ensureSession is synchronous, so a session/cancel arriving in the same
    // chunk as this prompt always finds the operation registered.
    const sessionId = this.ensureSession(params);
    const session = this.sessions.get(sessionId);
    const operation = this.startOperation(sessionId);

    try {
      const slashCommand = parseSlashCommand(extractPromptText(params));
      if (!slashCommand) {
        throw Object.assign(
          new Error("The adapter only handles its own slash commands; prompts go to native Copilot ACP."),
          { code: -32602 },
        );
      }
      return await this.handleSlashCommand(session, slashCommand, operation.signal);
    } finally {
      operation.finish();
    }
  }

  ensureSession(params = {}) {
    const known = this.knownSessionId(params);
    if (known) {
      return known;
    }

    // A helper prompted for a session this process never saw (e.g. after an
    // adapter restart) still needs a session to send its output to.
    const sessionId = params.sessionId || randomUUID();
    this.sessions.set(sessionId, this.sessionRecord(sessionId, params.cwd));
    return sessionId;
  }

  async handleSlashCommand(session, slashCommand, signal) {
    if (slashCommand.name === "/login") {
      return this.login(session, slashCommand.rawArgs, signal);
    }

    if (slashCommand.name === "/logout") {
      this.clearAdapterAuth();
      const restart = await this.applyAuthChange();
      this.sendText(
        session?.id,
        [
          "Adapter-held token authentication has been cleared.",
          ...restart.notes,
          ...(restart.error
            ? [`Could not restart the Copilot ACP backend: ${restart.error}`]
            : []),
          "Copilot CLI OAuth logout is an interactive CLI command; use `copilot` and `/logout` directly if you need to revoke a browser/device-flow login.",
        ].join("\n"),
      );
      return this.commandDone(slashCommand, {
        handledBy: "adapter",
        restartedBackend: restart.restarted,
      });
    }

    if (slashCommand.name === "/help") {
      this.sendText(session?.id, nativeCommandHelpText(this.availableNativeCommands(session?.id), slashCommand.rawArgs));
      return this.commandDone(slashCommand, { handledBy: "adapter" });
    }

    if (!NATIVE_HELPER_COMMANDS.has(slashCommand.name)) {
      this.sendText(session?.id, `${slashCommand.name} is not available in native Copilot ACP. Use /help for this session's commands; use the client's session picker to resume conversations.`);
      return this.commandDone(slashCommand, { handledBy: "adapter", error: "unsupported ACP command" }, "error");
    }

    if (DIRECT_COPILOT_COMMANDS[slashCommand.name]) {
      return this.runDirectCopilotCommand(session, slashCommand, signal);
    }

    switch (slashCommand.name) {
      case "/changelog":
        return this.handleChangelogCommand(session, slashCommand);
      case "/diff":
        return this.handleDiffCommand(session, slashCommand, signal);
      case "/experimental":
        return this.runConfigCommand(session, slashCommand, ["experimental", ...parseCommandArgs(slashCommand.rawArgs)], signal);
      case "/keep-alive":
        return this.runConfigCommand(session, slashCommand, ["keepAlive", ...parseCommandArgs(slashCommand.rawArgs)], signal);
      case "/exit":
        // A bare /exit never gets here: server.js maps it to native session/close.
        this.sendText(session?.id, "Usage: /exit (no arguments). This closes the native ACP session.");
        return this.commandDone(slashCommand, { handledBy: "adapter", error: "unexpected exit arguments" }, "error");
      case "/subagents":
        return this.handleSubagentsCommand(session, slashCommand);
      case "/settings": {
        const args = parseCommandArgs(slashCommand.rawArgs);
        const key = args[0] === "unset" ? args[1] : args[0];
        // Copilot's config CLI explicitly refuses complex subagent values.
        if (isSupportedAdapterSetting(key)) {
          return this.handleSettingsCommand(session, slashCommand);
        }
        return this.runConfigCommand(session, slashCommand,
          !args.length ? ["--list"] : args[0] === "unset" ? ["--rm", ...args.slice(1)] : args, signal);
      }
      default:
        return this.commandDone(slashCommand, { handledBy: "adapter", error: "unhandled helper" }, "error");
    }
  }

  // Native sends models, modes and configOptions itself (verified on 1.0.104),
  // and agent-shell's header reads them as they are.
  enhanceSessionStartResult(session, nativeResult = {}) {
    return {
      ...nativeResult,
      sessionId: session.id,
      cwd: nativeResult.cwd || session.cwd,
    };
  }

  enhanceNativeMessage(message = {}) {
    const update = message.params?.update;
    if (message.method !== "session/update") return message;
    const sessionId = message.params?.sessionId;
    const session = this.sessions.get(sessionId);
    if (session && update?.sessionUpdate === "config_option_update") {
      session.nativeConfigOptions = update.configOptions;
      session.modelId = configOptionCurrentValue(update.configOptions, "model") || session.modelId;
    }
    if (session && update?.sessionUpdate === "current_model_update") {
      session.modelId = update.currentModelId || session.modelId;
    }
    if (update?.sessionUpdate !== "available_commands_update") return message;
    this.nativeCommands.set(sessionId, update.availableCommands || []);
    while (this.nativeCommands.size > MAX_TRACKED_SUBAGENTS) {
      this.nativeCommands.delete(this.nativeCommands.keys().next().value);
    }
    return {
      ...message,
      params: {
        ...message.params,
        update: {
          ...update,
          availableCommands: this.availableNativeCommands(sessionId),
        },
      },
    };
  }

  availableNativeCommands(sessionId) {
    const helpers = listAvailableCommands().filter((command) => NATIVE_HELPER_COMMANDS.has(`/${command.name}`));
    // Native first, so a collision shows native's description for the command it runs.
    return mergeAvailableCommands(this.nativeCommands.get(sessionId), helpers);
  }

  enhanceNativeMessages(message = {}) {
    const enhanced = this.enhanceNativeMessage(message);
    const update = enhanced.params?.update;
    if (enhanced.method === "session/update" && ["tool_call", "tool_call_update"].includes(update?.sessionUpdate)) {
      for (const report of this.modelReportTurns.get(enhanced.params?.sessionId) || []) {
        recordModelTool(report, update);
      }
    }
    if (enhanced.method === "session/update" && update?.sessionUpdate === "tool_call") {
      this.trackNativeSubagentStart(enhanced.params?.sessionId || "", update);
    }
    return [enhanced];
  }

  beginModelReport(sessionId, prompt) {
    const session = this.sessions.get(sessionId);
    const models = modelIdsFromConfigOptions(session?.nativeConfigOptions);
    const mentioned = mentionedModels(prompt, models);
    const report = {
      sessionId, session, mentionedModels: mentioned,
      requestedSessionModel: session?.modelId || "unknown",
      sessionAgent: configOptionCurrentValue(session?.nativeConfigOptions, "agent") || "default Copilot agent",
      cursor: mentioned.length ? snapshotModelJournal(this.config.copilotSessionStatePath, session?.copilotSessionId) : null,
      recordedModels: new Set(), modelEvidence: new Set(), skills: new Set(), delegations: new Map(), completions: new Map(),
      overlap: false, finished: false,
    };
    const turns = this.modelReportTurns.get(sessionId) || new Set();
    if (turns.size) {
      report.overlap = true;
      for (const active of turns) active.overlap = true;
    }
    turns.add(report);
    this.modelReportTurns.set(sessionId, turns);
    return report;
  }

  async finishModelReport(report, response = {}) {
    if (!report || report.finished) return;
    report.finished = true;
    const turns = this.modelReportTurns.get(report.sessionId);
    turns?.delete(report);
    if (!turns?.size) this.modelReportTurns.delete(report.sessionId);
    if (!report.mentionedModels.length || !report.session || this.sessions.get(report.sessionId) !== report.session) return;
    if (!report.overlap) {
      // Reads are bounded and restricted to bytes appended since this prompt.
      // Configuration and prose are never evidence.
      for (const event of readModelJournal(this.config.copilotSessionStatePath, report.session.copilotSessionId, report.cursor)) {
        recordModelEvent(report, event);
      }
    }
    const output = modelReportOutput(report, response);
    this.sendText(report.sessionId, output.text, "agent_message_chunk", output.meta);
  }

  trackNativeSubagentStart(sessionId, update = {}) {
    const metadata = subagentStartMetadata(update.rawInput);
    if (!sessionId || !update.toolCallId || !metadata) return;
    const starts = this.nativeSubagentStarts.get(sessionId) || new Map();
    starts.set(update.toolCallId, { ...metadata, toolCallId: update.toolCallId });
    while (starts.size > MAX_TRACKED_SUBAGENTS) starts.delete(starts.keys().next().value);
    this.nativeSubagentStarts.set(sessionId, starts);
    // Bound aggregate tracking too: sessions may be numerous and long-lived.
    while (totalTrackedSubagents(this.nativeSubagentStarts) > MAX_TRACKED_SUBAGENTS) {
      const oldestSessionId = this.nativeSubagentStarts.keys().next().value;
      const oldestStarts = this.nativeSubagentStarts.get(oldestSessionId);
      oldestStarts.delete(oldestStarts.keys().next().value);
      if (!oldestStarts.size) this.nativeSubagentStarts.delete(oldestSessionId);
    }
  }

  async reportNativeSubagentDispatch(sessionId) {
    const currentStarts = this.nativeSubagentStarts.get(sessionId);
    const session = this.sessions.get(sessionId);
    if (!currentStarts?.size || !session?.copilotSessionId) return [];
    // Drain this turn's snapshot before awaiting; starts from a later turn must
    // remain tracked rather than being cleared by delayed reporting.
    const starts = new Map(currentStarts);
    this.nativeSubagentStarts.delete(sessionId);

    // The CLI can append several completion records after the ACP response.
    // Retry until every currently tracked start is present, never merely until
    // the first completion is found.
    let completions = new Map();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      completions = readSubagentCompletions({
        sessionStatePath: this.config.copilotSessionStatePath,
        sessionId: session.copilotSessionId,
        toolCallIds: [...starts.keys()],
      });
      if (completions.size === starts.size || attempt === 2) break;
      await delay(50);
    }

    const reports = [];
    for (const [toolCallId, start] of starts) {
      const evidence = completionEvidence(completions.get(toolCallId));
      const dispatched = evidence?.firstDispatchedModel || "unknown";
      const mismatch = Boolean(evidence?.firstDispatchedModel && start.requestedModel && dispatched !== start.requestedModel);
      const text = [
        !evidence
          ? `Subagent \`${start.agentName}\` model report (completion unverified).`
          : evidence.eventType === "subagent.failed"
            ? `Subagent \`${start.agentName}\` model report (subagent failed).`
            : `Subagent \`${start.agentName}\` model report.`,
        `Requested model: \`${start.requestedModel || "unknown"}\`.`,
        `Recorded first dispatched model: \`${dispatched}\`.`,
        ...(mismatch ? ["Warning: requested and recorded dispatched models differ; this can be Copilot alias/routing, not an adapter error."] : []),
        ...(!evidence ? ["Completion evidence was unavailable (missing, delayed, unreadable, or outside the bounded journal tail)."] : []),
      ].join(" ");
      this.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: randomUUID(),
          content: { type: "text", text: `${text}\n` },
          _meta: {
            activity: "subagent-dispatch-report",
            toolCallId,
            agentName: start.agentName,
            requestedModel: start.requestedModel || "unknown",
            firstDispatchedModel: dispatched,
            explicitModelOverride: evidence?.explicitModelOverride ?? null,
            evidence: evidence?.eventType || "unavailable",
            mismatch,
          },
        },
      });
      reports.push({ toolCallId, requestedModel: start.requestedModel, firstDispatchedModel: dispatched, mismatch });
    }
    return reports;
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
        loadSession: true,
        sessionCapabilities: {
          close: {},
          additionalDirectories: {},
          list: {},
        },
        _meta: {
          slashCommandPassthrough: true,
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

  closeSession(params = {}) {
    if (params.sessionId) {
      this.cancel({ sessionId: params.sessionId, reason: "Session closed" });
      this.sessions.delete(params.sessionId);
      this.nativeSubagentStarts.delete(params.sessionId);
      this.nativeCommands.delete(params.sessionId);
      this.modelReportTurns.delete(params.sessionId);
    }
    return {};
  }

  cancel(params = {}) {
    const sessionId = params.sessionId || params.session_id;
    const reason = params.reason || "User cancelled";
    const operations = sessionId
      ? [...(this.activeOperations.get(sessionId) || [])]
      : [...this.activeOperations.values()].flatMap((items) => [...items]);
    let cancelled = 0;

    for (const operation of operations) {
      if (!operation.controller.signal.aborted) {
        operation.controller.abort(new Error(reason));
        cancelled += 1;
      }
    }

    return {
      cancelled: cancelled > 0,
      count: cancelled,
      reason,
    };
  }

  startOperation(sessionId) {
    const controller = new AbortController();
    const operation = { controller };
    const operations = this.activeOperations.get(sessionId) || new Set();
    operations.add(operation);
    this.activeOperations.set(sessionId, operations);

    return {
      signal: controller.signal,
      finish: () => {
        operations.delete(operation);
        if (operations.size === 0) {
          this.activeOperations.delete(sessionId);
        }
      },
    };
  }

  knownSessionId(params = {}) {
    return params.sessionId && this.sessions.has(params.sessionId) ? params.sessionId : null;
  }

  async runConfigCommand(session, slashCommand, args, signal) {
    if (basename(this.config.copilotSettingsPath) !== "settings.json") {
      this.sendText(session?.id, "Copilot's config CLI requires a settings.json filename. Set COPILOT_SETTINGS_PATH to a settings.json path to use this command.");
      return this.commandDone(slashCommand, { handledBy: "adapter", error: "unsupported settings path" }, "error");
    }
    const result = await this.runner.runCommand(this.config.copilotCommand, ["config", ...args], {
      cwd: session?.cwd || this.config.cwd,
      env: {
        COPILOT_AUTO_UPDATE: "false",
        ...this.globalEnv,
        ...(session?.env || {}),
        // Honor custom adapter settings paths without changing user files.
        COPILOT_HOME: dirname(this.config.copilotSettingsPath),
      },
      timeoutMs: this.config.requestTimeoutMs,
      signal,
    });
    this.sendOutput(session?.id, result);
    if (result.ok && (args.includes("--rm") || args.filter((arg) => !arg.startsWith("--")).length > 1)) {
      this.sendText(session?.id, "Saved Copilot settings. Restart the session for startup settings to take effect.");
    }
    return this.commandDone(slashCommand, { handledBy: "copilot-config", exitCode: result.exitCode },
      result.aborted ? "cancelled" : result.ok ? "end_turn" : "error");
  }

  loadChangelog() {
    this.changelogPromise ||= fetchCopilotChangelog({
      fetchImpl: this.fetchImpl,
      url: this.config.changelogUrl || DEFAULT_CHANGELOG_URL,
      timeoutMs: this.config.changelogTimeoutMs || 5000,
    }).catch((error) => {
      this.changelogPromise = null;
      throw error;
    });
    return this.changelogPromise;
  }

  async handleChangelogCommand(session, slashCommand) {
    try {
      this.sendText(session?.id, selectChangelog(await this.loadChangelog(), slashCommand.rawArgs).text);
      return this.commandDone(slashCommand, { handledBy: "adapter" });
    } catch (error) {
      return this.changelogFailure(session?.id, slashCommand, error);
    }
  }

  changelogFailure(sessionId, slashCommand, error) {
    this.sendText(
      sessionId,
      `Could not load the Copilot CLI changelog: ${error.message}\n${this.config.changelogUrl || DEFAULT_CHANGELOG_URL}`,
    );
    return this.commandDone(slashCommand, { handledBy: "adapter", error: error.message }, "error");
  }

  // `/changelog summarize` needs a model, so server.js rewrites it into an
  // ordinary native prompt carrying the selected release notes.
  isChangelogSummary(params = {}) {
    const slashCommand = parseSlashCommand(extractPromptText(params));
    return slashCommand?.name === "/changelog" &&
      /^summarize\b/i.test(slashCommand.rawArgs) &&
      !this.nativeAdvertises(params.sessionId, "/changelog");
  }

  async changelogSummaryPrompt(params = {}) {
    const selected = selectChangelog(await this.loadChangelog(), parseSlashCommand(extractPromptText(params)).rawArgs);
    return `Summarize these official GitHub Copilot CLI release notes. Do not discuss the current repository:\n\n${selected.text}`;
  }

  async handleDiffCommand(session, slashCommand, signal) {
    const rawArgs = parseCommandArgs(slashCommand.rawArgs);
    const args = ["--no-pager", "diff", "--no-ext-diff", ...(rawArgs.length ? rawArgs : ["HEAD", "--"] )];
    const result = await this.runner.runCommand("git", args, {
      cwd: session?.cwd || this.config.cwd,
      env: { ...this.globalEnv, ...(session?.env || {}) },
      timeoutMs: this.config.requestTimeoutMs,
      signal,
    });
    this.sendOutput(session?.id, result);
    if (result.ok && !result.stdout && !result.stderr) {
      this.sendText(session?.id, "No tracked changes.");
    }
    return this.commandDone(slashCommand, { handledBy: "adapter", exitCode: result.exitCode }, result.aborted ? "cancelled" : result.ok ? "end_turn" : "error");
  }

  handleSubagentsCommand(session, slashCommand) {
    const args = parseCommandArgs(slashCommand.rawArgs);
    const [first] = args;
    const projectAgents = discoverProjectAgents(session?.cwd || this.config.cwd);

    if (!first || first === "list") {
      this.sendText(
        session?.id,
        subagentsSummary(readSettings(this.config.copilotSettingsPath), this.config, projectAgents),
      );
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
      this.sendText(session?.id, subagentDetail(agentName, value, this.config, projectAgents));
      return this.commandDone(slashCommand, { handledBy: "adapter" });
    }

    return this.updateSubagentSetting(session, slashCommand, agentName, {
      model,
      effortLevel,
      contextTier,
    });
  }

  handleSettingsCommand(session, slashCommand) {
    const [key, ...valueParts] = parseCommandArgs(slashCommand.rawArgs);
    if (key === "unset") {
      return this.updateSetting(session, slashCommand, valueParts[0], undefined);
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

  async runDirectCopilotCommand(session, slashCommand, signal) {
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
      timeoutMs: this.config.requestTimeoutMs,
      signal,
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
    }, result.aborted ? "cancelled" : result.ok ? "end_turn" : "error");
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

  async authenticate(params = {}) {
    const login = loginFromMethodId(params.methodId, this.config);
    const plan = buildGithubLoginCommand(login, this.config);

    if (!plan.ok) {
      throw Object.assign(new Error(plan.message), { code: -32001 });
    }

    if (plan.type === "api-key") {
      this.globalEnv = { ...this.globalEnv, ...plan.env };
      const restart = await this.applyAuthChange();
      if (restart.error) {
        throw Object.assign(
          new Error(`Could not restart the Copilot ACP backend: ${restart.error}`),
          { code: -32001 },
        );
      }
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

  async login(session, rawArgs, signal) {
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
      // globalEnv is what the native backend is relaunched with, so it always
      // has to carry the token, not just the session that ran /login.
      this.globalEnv = { ...this.globalEnv, ...plan.env };
      if (session) {
        session.env = { ...(session.env || {}), ...plan.env };
      }

      const restart = await this.applyAuthChange();
      if (restart.error) {
        this.sendText(
          session?.id,
          `${plan.message}\nCould not restart the Copilot ACP backend: ${restart.error}`,
        );
        return {
          stopReason: "error",
          _meta: { auth: "api-key", error: restart.error },
        };
      }

      this.sendText(session?.id, [plan.message, ...restart.notes].join("\n"));
      return {
        stopReason: "end_turn",
        _meta: { auth: "api-key", restartedBackend: restart.restarted },
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
      signal,
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
      stopReason: result.aborted ? "cancelled" : result.ok ? "end_turn" : "error",
      _meta: {
        exitCode: result.exitCode,
        error: result.error,
      },
    };
  }

  async logout() {
    this.clearAdapterAuth();
    await this.applyAuthChange();
    return {};
  }

  clearAdapterAuth() {
    this.globalEnv = {};
    for (const session of this.sessions.values()) {
      session.env = {};
    }
  }

  /**
   * Relaunch the native backend so a credential change actually reaches it.
   * A running process cannot have its environment rewritten.
   */
  async applyAuthChange() {
    if (!this.restartBackend) {
      return { restarted: false, notes: [], error: "" };
    }

    try {
      const restarted = await this.restartBackend();
      if (!restarted) {
        return { restarted: false, notes: [], error: "" };
      }
      this.nativeCommands.clear();
      this.nativeSubagentStarts.clear();
      this.modelReportTurns.clear();
      return {
        restarted: true,
        notes: [
          "Restarted the Copilot ACP backend so it picks up the new credentials.",
          "Copilot-side sessions did not survive the restart. Start a new agent-shell or load a conversation through the client's session picker before your next prompt.",
        ],
        error: "",
      };
    } catch (error) {
      return { restarted: false, notes: [], error: error.message };
    }
  }

  /**
   * Emitted after the session/new result reaches the client. setImmediate rather
   * than queueMicrotask: the result is written from a microtask continuation, and
   * a client that receives available_commands_update for a session it has not
   * registered yet will discard it.
   */
  scheduleAvailableCommands(sessionId) {
    setImmediate(() => {
      if (this.sessions.has(sessionId)) {
        this.sendAvailableCommands(sessionId);
      }
    });
  }

  sendAvailableCommands(sessionId) {
    this.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: this.availableNativeCommands(sessionId),
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
    if (!text) {
      return;
    }
    if (!sessionId) {
      // Dropping output silently is how the un-awaited ensureSession bug stayed hidden.
      process.stderr.write(
        `copilot-acp-adapter: dropped a ${sessionUpdate} with no sessionId\n`,
      );
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

function subagentStartMetadata(rawInput) {
  const input = rawInput && typeof rawInput === "object" ? rawInput : {};
  const agentName = input.agent_type || input.agentType || input.agent_name || input.agentName;
  if (typeof agentName !== "string" || !agentName.trim()) return null;
  // This is a request only. It is intentionally never used as dispatch proof.
  const requestedModel = typeof input.model === "string" ? input.model.trim() : "";
  return { agentName: agentName.trim(), requestedModel };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  if (typeof params.content === "string") return params.content;
  return "";
}

function mergeAuthMethods(nativeMethods = [], localMethods = []) {
  const result = [];
  const seen = new Set();
  for (const method of [...(nativeMethods || []), ...(localMethods || [])]) {
    if (!method?.id || seen.has(method.id)) {
      continue;
    }
    seen.add(method.id);
    result.push(method);
  }
  return result;
}

function modelIdsFromConfigOptions(configOptions = []) {
  const option = (configOptions || []).find((entry) => entry?.category === "model" || entry?.id === "model");
  // Options may be grouped; only leaves carry a model id.
  const flatten = (options = []) => options.flatMap((entry) => entry.options ? flatten(entry.options) : [entry.value]);
  return option ? flatten(option.options) : [];
}

function nativeCommandHelpText(commands, rawArgs) {
  const [topic] = parseCommandArgs(rawArgs);
  if (topic) {
    const command = commands.find((entry) => entry.name === topic.replace(/^\//, ""));
    return command ? `/${command.name} - ${command.description}\n${command.input?.hint || ""}`
      : `${topic} is not available in this ACP session. Use /help for the current commands.`;
  }
  return ["Copilot ACP adapter commands:", "", ...commands.map((entry) => `/${entry.name} - ${entry.description}`)].join("\n");
}

function mergeAvailableCommands(nativeCommands = [], localCommands = []) {
  const result = [];
  const seen = new Set();
  for (const command of [
    ...(Array.isArray(nativeCommands) ? nativeCommands : []),
    ...(Array.isArray(localCommands) ? localCommands : []),
  ]) {
    const key = String(command?.name || "").replace(/^\/+/, "");
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(command);
  }
  return result;
}

function configOptionCurrentValue(configOptions = [], id) {
  return (configOptions || []).find((option) => option?.id === id || option?.category === id)?.currentValue;
}

function subagentsSummary(settings, config, projectAgents) {
  const configured = listSubagentSettings(settings);
  const projectByName = new Map(projectAgents.agents.map((agent) => [agent.name, agent]));
  const names = [...new Set([...projectByName.keys(), ...Object.keys(configured)])].sort();
  const lines = [
    "Copilot subagent model settings:",
    `Settings file: ${config.copilotSettingsPath}`,
    `Project agents directory: ${projectAgents.agentsDir || "(no git root found)"}`,
    "",
  ];

  if (!names.length) {
    lines.push("No project-defined or per-subagent settings are configured. Subagents inherit the parent session model, effort level, and context tier.");
    lines.push("");
    lines.push("Common agent names: explore, general-purpose, code-review");
  } else {
    for (const agentName of names) {
      lines.push(formatSubagentSetting(agentName, configured[agentName], projectByName.get(agentName)));
    }
  }

  lines.push("");
  lines.push("Usage:");
  lines.push("- `/subagents <agent-name>`");
  lines.push("- `/subagents set <agent-name> <model> [effortLevel] [contextTier]`");
  lines.push("- `/subagents unset <agent-name>`");
  return lines.join("\n");
}

function subagentDetail(agentName, value, config, projectAgents) {
  const projectAgent = projectAgents.agents.find((agent) => agent.name === agentName);
  if (!value && !projectAgent) {
    return [
      `${subagentSettingPath(agentName)} is not configured.`,
      `No project agent named ${agentName} was found in ${projectAgents.agentsDir || "a git-root .github/agents directory"}.`,
      "Copilot will inherit the parent session defaults.",
      `Settings file: ${config.copilotSettingsPath}`,
    ].join("\n");
  }
  return [
    formatSubagentSetting(agentName, value, projectAgent),
    `Settings file: ${config.copilotSettingsPath}`,
  ].join("\n");
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

function formatSubagentSetting(agentName, value, projectAgent) {
  const lines = [
    `${agentName}:`,
    `- source: ${projectAgent ? projectAgent.relativePath : "settings only"}`,
    `- model: ${value?.model || "inherit"}`,
    `- effortLevel: ${value?.effortLevel || "inherit"}`,
    `- contextTier: ${value?.contextTier || "inherit"}`,
  ];
  if (projectAgent?.description) {
    lines.splice(2, 0, `- description: ${projectAgent.description}`);
  }
  return lines.join("\n");
}

function isSupportedAdapterSetting(key) {
  return /^subagents\.agents\.[A-Za-z0-9_-]+$/.test(String(key || ""));
}

function isValidSubagentName(agentName) {
  return /^[A-Za-z0-9_-]+$/.test(String(agentName || ""));
}

function totalTrackedSubagents(startsBySession) {
  let total = 0;
  for (const starts of startsBySession.values()) total += starts.size;
  return total;
}
