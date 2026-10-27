import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CopilotAcpAdapter } from "../src/adapter.js";

// available_commands_update is deliberately deferred until after the session/new
// result has been written, so tests that look for it have to yield first.
function flushSessionUpdates() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createAdapter(options = {}) {
  const settingsDir = mkdtempSync(join(tmpdir(), "copilot-acp-settings-"));
  const sessionStateDir = mkdtempSync(join(tmpdir(), "copilot-acp-session-state-"));
  const calls = [];
  const notifications = [];
  const runner = {
    calls,
    async runCommand(command, args, options) {
      calls.push({ type: "command", command, args, options });
      if (args[0] === "login") {
        options.onStdout?.("To authenticate, visit https://github.com/login/device and enter code ABCD-1234.\n");
      } else {
        options.onStdout?.(`command: ${args.join(" ")}\n`);
      }
      return { ok: true, exitCode: 0, stdout: "logged in", stderr: "" };
    },
  };
  const activeRunner = options.runner || runner;
  activeRunner.calls ||= calls;
  const adapter = new CopilotAcpAdapter({
    config: {
      cwd: "/tmp",
      copilotCommand: "/home/jai/.local/bin/copilot",
      githubHost: "https://github.com",
      enterpriseHost: "",
      apiKey: "",
      loginBrowser: "echo",
      loginHeadless: true,
      copilotSettingsPath: join(settingsDir, "settings.json"),
      copilotSessionStatePath: sessionStateDir,
      ...(options.config || {}),
    },
    runner: activeRunner,
    fetchImpl: options.fetchImpl,
    restartBackend: options.restartBackend,
    notify(method, params) {
      notifications.push({ method, params });
    },
  });
  return {
    adapter,
    runner: activeRunner,
    notifications,
    settingsPath: join(settingsDir, "settings.json"),
    sessionStateDir,
  };
}

test("changelog is fetched directly instead of sent as a model prompt", async () => {
  const { adapter, runner, notifications } = createAdapter({
    fetchImpl: async () => ({ ok: true, text: async () => "# Changelog\n\n## 1.0.0\n\nFast.\n" }),
  });
  const { sessionId } = await adapter.adoptNativeSession({ cwd: "/repo" }, { sessionId: "native" });
  const result = await adapter.handle("session/prompt", { sessionId, prompt: "/changelog" });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(result._meta.handledBy, "adapter");
  assert.equal(runner.calls.length, 0);
  assert.equal(notifications.some((item) => item.params.update.content?.text.includes("Fast.")), true);
});

test("changelog summarize becomes a native prompt carrying the selected notes", async () => {
  const { adapter } = createAdapter({
    fetchImpl: async () => ({ ok: true, text: async () => "# Changelog\n\n## 1.0.1\n\nNewer.\n\n## 1.0.0\n\nFast.\n" }),
  });
  const { sessionId } = await adapter.adoptNativeSession({}, { sessionId: "native" });
  const params = { sessionId, prompt: "/changelog summarize 1.0.0" };

  assert.equal(adapter.isChangelogSummary(params), true);
  assert.equal(adapter.shouldHandleLocally("session/prompt", params), false);
  const text = await adapter.changelogSummaryPrompt(params);
  assert.match(text, /^Summarize these official GitHub Copilot CLI release notes/);
  assert.match(text, /Fast\./);
  assert.doesNotMatch(text, /Newer\./);
  assert.equal(adapter.isChangelogSummary({ sessionId, prompt: "/changelog 1.0.0" }), false);
});

test("initialize keeps native capabilities and adds adapter auth methods", () => {
  const { adapter } = createAdapter();
  const result = adapter.enhanceInitialize({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } },
    agentInfo: { name: "Copilot", version: "1.0.104" },
    authMethods: [{ id: "copilot-login", name: "Log in with Copilot CLI" }],
  });
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.agentCapabilities.loadSession, true);
  assert.deepEqual(result.agentCapabilities.sessionCapabilities, { list: {}, close: {} });
  assert.deepEqual(result.agentCapabilities.auth, { logout: {} });
  assert.equal(result.agentCapabilities._meta.backend, "native-acp-proxy");
  assert.equal(result.agentInfo.name, "copilot-acp-adapter");
  assert.equal(result.agentInfo._meta.nativeAgentInfo.version, "1.0.104");
  assert.deepEqual(result.authMethods.map((method) => method.id).slice(0, 2), ["copilot-login", "github.com"]);
  assert.equal(result.authMethods.some((method) => method.id === "github-enterprise"), true);
  assert.equal(result.authMethods.some((method) => method.id === "api-key"), true);
});

test("native command snapshots retain helpers without inventing commands or skills", async () => {
  const { adapter, notifications } = createAdapter();
  const repo = mkdtempSync(join(tmpdir(), "copilot-acp-native-commands-"));
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".github", "skills", "adapter-smoke-test"), { recursive: true });
  writeFileSync(
    join(repo, ".github", "skills", "adapter-smoke-test", "SKILL.md"),
    "---\nname: adapter-smoke-test\ndescription: Run the adapter smoke test\n---\n",
  );
  const { sessionId } = await adapter.adoptNativeSession({ cwd: repo }, { sessionId: "native" });

  const message = adapter.enhanceNativeMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "refine", description: "Native-only command" },
          { name: "enabled-skill", description: "Native enabled skill" },
        ],
      },
    },
  });
  const commands = message.params.update.availableCommands;

  assert.equal(commands.filter((command) => command.name === "help").length, 1);
  assert.equal(commands.some((command) => command.name === "refine"), true);
  assert.equal(commands.some((command) => command.name === "enabled-skill"), true);
  assert.equal(commands.some((command) => command.name === "resume"), false);
  assert.equal(commands.some((command) => command.name === "tasks"), false);
  assert.equal(commands.some((command) => command.name === "limits"), false);
  assert.equal(commands.some((command) => command.name === "adapter-smoke-test"), false);
  await flushSessionUpdates();
  assert.deepEqual(notifications.at(-1).params.update.availableCommands, commands,
    "the deferred update must not overwrite the native snapshot");
  assert.equal(adapter.shouldHandleLocally("session/prompt", { sessionId, prompt: "/enabled-skill" }), false);
  const unavailable = await adapter.handle("session/prompt", { sessionId, prompt: "/resume" });
  assert.equal(unavailable.stopReason, "error");
  const refreshed = adapter.enhanceNativeMessage({ method: "session/update", params: {
    sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] },
  } });
  assert.equal(refreshed.params.update.availableCommands.some((command) => command.name === "enabled-skill"), false);
});

test("native session metadata passes through untouched", async () => {
  const { adapter } = createAdapter();
  const configOptions = [{ id: "native-model", category: "model", currentValue: "permitted", options: [
    { name: "Allowed", options: [{ value: "permitted", name: "Permitted", _meta: { multiplier: 2 } }] },
  ] }];
  const models = { currentModelId: "permitted", availableModels: [{ modelId: "permitted", name: "Permitted" }] };
  const modes = { currentModeId: "native#agent", availableModes: [{ id: "native#agent", name: "Agent" }] };
  const result = await adapter.adoptNativeSession({ cwd: "/loaded" }, { sessionId: "native", configOptions, models, modes });
  assert.equal(result.configOptions, configOptions);
  assert.equal(result.models, models);
  assert.equal(result.modes, modes);
  assert.equal(adapter.sessions.get("native").modelId, "permitted");
  assert.equal(adapter.sessions.get("native").cwd, "/loaded");

  // Without native models the adapter no longer synthesizes or discovers any.
  const bare = await adapter.adoptNativeSession({}, { sessionId: "bare", configOptions });
  assert.equal(bare.models, undefined);
  assert.equal(bare.modes, undefined);
  assert.equal(adapter.sessions.get("bare").modelId, "permitted");
});

test("native simple settings use CLI validation and preserve complex setting bridge", async () => {
  const { adapter, runner, settingsPath } = createAdapter();
  const { sessionId } = await adapter.adoptNativeSession({}, { sessionId: "settings", models: { availableModels: [], currentModelId: "auto" } });
  for (const [prompt, expected] of [
    ["/settings", ["config", "--list"]],
    ["/settings footer.showQuota off", ["config", "footer.showQuota", "off"]],
    ["/settings unset theme", ["config", "--rm", "theme"]],
    ["/experimental on", ["config", "experimental", "on"]],
  ]) {
    await adapter.handle("session/prompt", { sessionId, prompt });
    assert.deepEqual(runner.calls.at(-1).args, expected);
  }
  await adapter.handle("session/prompt", { sessionId, prompt: "/subagents set explore inherit high inherit" });
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).subagents.agents.explore.effortLevel, "high");
  assert.equal(runner.calls.length, 4);
});

test("native skill and subagent tool calls announce their activity", () => {
  const { adapter } = createAdapter();
  const skillMessages = adapter.enhanceNativeMessages({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "skill-1",
        title: "Using skill: test-runner",
        kind: "other",
        status: "pending",
        rawInput: { skill: "test-runner" },
      },
    },
  });
  const subagentMessages = adapter.enhanceNativeMessages({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "task-1",
        title: "Explore the adapter",
        kind: "other",
        status: "pending",
        rawInput: { agent_type: "adapter-explorer", prompt: "Inspect the adapter" },
      },
    },
  });

  assert.equal(skillMessages.length, 2);
  assert.equal(skillMessages[0].params.update.sessionUpdate, "agent_thought_chunk");
  assert.equal(skillMessages[0].params.update.content.text, "Enabling `test-runner` skill.\n");
  assert.equal(skillMessages[1].params.update.toolCallId, "skill-1");
  assert.deepEqual(adapter.enhanceNativeMessages(skillMessages[1]), [skillMessages[1]]);
  assert.equal(subagentMessages.length, 2);
  assert.equal(subagentMessages[0].params.update.sessionUpdate, "agent_thought_chunk");
  assert.equal(
    subagentMessages[0].params.update.content.text,
    "Delegating to `adapter-explorer` subagent.\n",
  );
  assert.equal(subagentMessages[1].params.update.toolCallId, "task-1");
});

test("session/cancel aborts an in-flight helper command", async () => {
  const calls = [];
  const runner = {
    runCommand(command, args, options) {
      calls.push({ command, args, options });
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => {
          resolve({ ok: false, aborted: true, exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", error: options.signal.reason.message });
        }, { once: true });
      });
    },
  };
  const { adapter } = createAdapter({ runner });
  const { sessionId } = await adapter.adoptNativeSession({}, { sessionId: "native" });

  const promptResult = adapter.handle("session/prompt", { sessionId, prompt: "/diff" });
  assert.equal(calls.length, 1, "the operation is registered before any await");
  assert.equal(calls[0].options.signal.aborted, false);

  const cancelResult = adapter.cancel({ sessionId, reason: "User cancelled" });
  const result = await promptResult;

  assert.deepEqual(cancelResult, { cancelled: true, count: 1, reason: "User cancelled" });
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(result.stopReason, "cancelled");
});

test("session/cancel reports no-op when there is no active operation", async () => {
  const { adapter } = createAdapter();
  const { sessionId } = await adapter.adoptNativeSession({}, { sessionId: "native" });

  assert.deepEqual(adapter.cancel({ sessionId }), {
    cancelled: false,
    count: 0,
    reason: "User cancelled",
  });
});

test("native backend mode proxies Copilot-owned slash commands", () => {
  const { adapter } = createAdapter();

  assert.equal(adapter.shouldHandleLocally("session/prompt", { prompt: "/add-dir ../logs" }), false);
  assert.equal(adapter.shouldHandleLocally("session/prompt", { prompt: "/allow-all" }), false);
  assert.equal(adapter.shouldHandleLocally("session/prompt", { prompt: "/autopilot" }), false);
  assert.equal(adapter.shouldHandleLocally("session/prompt", { prompt: "/memory" }), false);
  for (const command of [
    "/permissions",
    "/blame main.js",
    "/every 5m check status",
    "/after 10m run tests",
    "/sandbox show",
    "/subconscious status",
  ]) {
    assert.equal(adapter.shouldHandleLocally("session/prompt", { prompt: command }), false, command);
  }
  assert.equal(adapter.shouldHandleLocally("session/prompt", {
    prompt: [{ type: "text", text: "/new" }],
  }), false);
  assert.equal(adapter.shouldHandleLocally("session/prompt", { prompt: "/clear" }), false);
  assert.equal(adapter.shouldHandleLocally("session/prompt", { prompt: "/settings" }), true);
});

test("a native-advertised command wins over a same-named adapter helper", async () => {
  const { adapter } = createAdapter();
  await adapter.adoptNativeSession({}, { sessionId: "native" });
  assert.equal(adapter.shouldHandleLocally("session/prompt", { sessionId: "native", prompt: "/changelog" }), true,
    "before native discovery the helper still runs locally");
  const message = adapter.enhanceNativeMessage({ method: "session/update", params: { sessionId: "native", update: {
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "changelog", description: "Native changelog" }],
  } } });

  assert.equal(adapter.shouldHandleLocally("session/prompt", { sessionId: "native", prompt: "/changelog" }), false);
  const changelog = message.params.update.availableCommands.filter((command) => command.name === "changelog");
  assert.deepEqual(changelog.map((command) => command.description), ["Native changelog"]);
});

test("an adapter helper native doesn't advertise is still handled locally", async () => {
  const { adapter } = createAdapter();
  await adapter.adoptNativeSession({}, { sessionId: "native" });
  adapter.enhanceNativeMessage({ method: "session/update", params: { sessionId: "native", update: {
    sessionUpdate: "available_commands_update", availableCommands: [{ name: "context", description: "Native context" }],
  } } });

  assert.equal(adapter.shouldHandleLocally("session/prompt", { sessionId: "native", prompt: "/changelog" }), true);
  assert.equal(adapter.shouldHandleLocally("session/prompt", { sessionId: "native", prompt: "/context" }), false);
  assert.equal(adapter.availableNativeCommands("native").some((command) => command.name === "theme"), false,
    "/theme is a terminal color setting with no meaning in an ACP client");
});

test("/version and /update run Copilot CLI subcommands", async () => {
  const { adapter, runner, notifications } = createAdapter();
  const { sessionId } = await adapter.adoptNativeSession({ cwd: "/repo" }, { sessionId: "native" });
  const result = await adapter.handle("session/prompt", { sessionId, prompt: "/version" });
  await adapter.handle("session/prompt", { sessionId, prompt: "/update" });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(result._meta.handledBy, "copilot-command");
  assert.deepEqual(runner.calls.map((call) => call.args), [["--version"], ["update"]]);
  assert.equal(runner.calls[0].options.cwd, "/repo");
  assert.equal(notifications.some((item) => item.params.update.content?.text === "command: --version\n"), true);
});

test("prompts that are not adapter slash commands are rejected locally", async () => {
  const { adapter } = createAdapter();
  const { sessionId } = await adapter.adoptNativeSession({}, { sessionId: "native" });
  assert.equal(adapter.shouldHandleLocally("session/prompt", { sessionId, prompt: "hello" }), false);
  await assert.rejects(adapter.handle("session/prompt", { sessionId, prompt: "hello" }), { code: -32602 });
});

test("diff runs git directly instead of asking the model", async () => {
  const { adapter, runner } = createAdapter();
  const { sessionId } = await adapter.adoptNativeSession({ cwd: "/repo" }, { sessionId: "native" });
  const result = await adapter.handle("session/prompt", { sessionId, prompt: "/diff" });

  assert.equal(result._meta.handledBy, "adapter");
  assert.equal(runner.calls[0].type, "command");
  assert.equal(runner.calls[0].command, "git");
  assert.deepEqual(runner.calls[0].args, ["--no-pager", "diff", "--no-ext-diff", "HEAD", "--"]);
});

test("subagents command is handled natively instead of prompt mode", async () => {
  const { adapter, runner, notifications } = createAdapter();
  const { sessionId } = await adapter.adoptNativeSession({ cwd: "/repo" }, { sessionId: "native" });
  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/subagents",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(runner.calls.length, 0);
  assert.equal(result._meta.handledBy, "adapter");
  assert.equal(
    notifications.some(
      (notification) =>
        notification.method === "session/update" &&
        notification.params.update.content?.text.includes("Copilot subagent model settings"),
    ),
    true,
  );
});

test("subagents command writes Copilot settings shape", async () => {
  const { adapter, runner, settingsPath } = createAdapter();
  const { sessionId } = await adapter.adoptNativeSession({ cwd: "/repo" }, { sessionId: "native" });
  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/subagents set explore claude-sonnet-5 high long_context",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    subagents: {
      agents: {
        explore: {
          model: "claude-sonnet-5",
          effortLevel: "high",
          contextTier: "long_context",
        },
      },
    },
  });
});

test("subagents command lists project agents from git root", async () => {
  const { adapter, runner, notifications } = createAdapter();
  const repo = mkdtempSync(join(tmpdir(), "copilot-acp-repo-"));
  const nested = join(repo, "packages", "app");
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".github", "agents"), { recursive: true });
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    join(repo, ".github", "agents", "explore.md"),
    "---\nname: explore\ndescription: Explore the codebase\n---\n",
  );

  const { sessionId } = await adapter.adoptNativeSession({ cwd: nested }, { sessionId: "native" });
  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/subagents",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(runner.calls.length, 0);
  assert.equal(
    notifications.some(
      (notification) =>
        notification.method === "session/update" &&
        notification.params.update.content?.text.includes("source: .github/agents/explore.md") &&
        notification.params.update.content?.text.includes("description: Explore the codebase"),
    ),
    true,
  );
});

test("subagents command prefers cwd agents over git root agents", async () => {
  const { adapter, notifications } = createAdapter();
  const repo = mkdtempSync(join(tmpdir(), "copilot-acp-repo-"));
  const nested = join(repo, "packages", "app");
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".github", "agents"), { recursive: true });
  mkdirSync(join(nested, ".github", "agents"), { recursive: true });
  writeFileSync(join(repo, ".github", "agents", "root-agent.md"), "description: Root agent\n");
  writeFileSync(join(nested, ".github", "agents", "local-agent.md"), "description: Local agent\n");

  const { sessionId } = await adapter.adoptNativeSession({ cwd: nested }, { sessionId: "native" });
  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/subagents",
  });

  assert.equal(result.stopReason, "end_turn");
  const message = notifications
    .map((notification) => notification.params.update.content?.text || "")
    .find((text) => text.includes("Copilot subagent model settings"));
  assert.match(message, /local-agent:/);
  assert.doesNotMatch(message, /root-agent:/);
});

test("subagents command shows project agent detail without settings", async () => {
  const { adapter, notifications } = createAdapter();
  const repo = mkdtempSync(join(tmpdir(), "copilot-acp-repo-"));
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".github", "agents"), { recursive: true });
  writeFileSync(join(repo, ".github", "agents", "code-review.md"), "description: Review code changes\n");

  const { sessionId } = await adapter.adoptNativeSession({ cwd: repo }, { sessionId: "native" });
  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/subagents code-review",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(
    notifications.some(
      (notification) =>
        notification.method === "session/update" &&
        notification.params.update.content?.text.includes("code-review:") &&
        notification.params.update.content?.text.includes("model: inherit"),
    ),
    true,
  );
});

test("settings subagent bridge can unset a configured agent", async () => {
  const { adapter, settingsPath } = createAdapter();
  const { sessionId } = await adapter.adoptNativeSession({ cwd: "/repo" }, { sessionId: "native" });

  await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/settings subagents.agents.code-review gpt-5.4",
  });
  await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/settings unset subagents.agents.code-review",
  });

  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {});
});

test("login api-key stores the token for the session and the relaunched backend", async () => {
  const { adapter, runner } = createAdapter();
  const { sessionId } = await adapter.adoptNativeSession({}, { sessionId: "native" });
  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/login api-key test-token",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(runner.calls.length, 0);
  assert.equal(adapter.globalEnv.COPILOT_GITHUB_TOKEN, "test-token");
  assert.equal(adapter.sessions.get(sessionId).env.GH_TOKEN, "test-token");
});

test("login github streams device-flow output to the session", async () => {
  const { adapter, notifications } = createAdapter();
  const { sessionId } = await adapter.adoptNativeSession({}, { sessionId: "native" });
  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/login github",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(
    notifications.some(
      (notification) =>
        notification.method === "session/update" &&
        notification.params.update.content?.text.includes("https://github.com/login/device"),
    ),
    true,
  );
});

test("bare login shows choices instead of assuming GitHub.com", async () => {
  const { adapter, runner, notifications } = createAdapter();
  const { sessionId } = await adapter.adoptNativeSession({}, { sessionId: "native" });
  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/login",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(runner.calls.length, 0);
  assert.equal(
    notifications.some(
      (notification) =>
        notification.method === "session/update" &&
        notification.params.update.content?.text.includes("/login enterprise <hostname>"),
    ),
    true,
  );
});

test("a prompt for an unknown session still delivers its output", async () => {
  const { adapter, notifications } = createAdapter();

  const result = await adapter.handle("session/prompt", {
    sessionId: "session-from-a-previous-adapter-run",
    prompt: "/help",
  });

  assert.equal(result.stopReason, "end_turn");
  const chunks = notifications.filter(
    (entry) => entry.params?.update?.sessionUpdate === "agent_message_chunk",
  );
  assert.equal(chunks.length, 1, "the first turn must not silently drop its output");
  assert.equal(chunks[0].params.sessionId, "session-from-a-previous-adapter-run");
  assert.match(chunks[0].params.update.content.text, /Copilot ACP adapter commands/);
});

test("ensureSession resolves to the session id it created", async () => {
  const { adapter } = createAdapter();

  const sessionId = await adapter.ensureSession({ sessionId: "brand-new" });

  assert.equal(sessionId, "brand-new");
  assert.equal(adapter.sessions.has("brand-new"), true);
});

test("/login api-key restarts the native backend with the new credentials", async () => {
  let restarts = 0;
  const { adapter, notifications } = createAdapter({
    restartBackend: async () => {
      restarts += 1;
      return true;
    },
  });
  const { sessionId } = await adapter.adoptNativeSession({}, { sessionId: "native" });

  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/login api-key ghp_example",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(result._meta.restartedBackend, true);
  assert.equal(restarts, 1);
  assert.equal(adapter.globalEnv.COPILOT_GITHUB_TOKEN, "ghp_example");
  const text = notifications
    .filter((entry) => entry.params?.update?.content?.text)
    .map((entry) => entry.params.update.content.text)
    .join("\n");
  assert.match(text, /Restarted the Copilot ACP backend/);
});

test("/login api-key reports a failed backend restart instead of claiming success", async () => {
  const { adapter } = createAdapter({
    restartBackend: async () => {
      throw new Error("mkfifo failed");
    },
  });
  const { sessionId } = await adapter.adoptNativeSession({}, { sessionId: "native" });

  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/login api-key ghp_example",
  });

  assert.equal(result.stopReason, "error");
  assert.match(result._meta.error, /mkfifo failed/);
});

test("/login rejects a typo instead of treating it as a hostname", async () => {
  const { adapter, runner } = createAdapter();
  const { sessionId } = await adapter.adoptNativeSession({}, { sessionId: "native" });

  const result = await adapter.handle("session/prompt", { sessionId, prompt: "/login gihub" });

  assert.equal(result.stopReason, "error");
  assert.equal(
    runner.calls.some((call) => call.type === "command" && call.args?.[0] === "login"),
    false,
    "a typo must not launch a login against https://gihub",
  );
});

test("/login accepts a bare hostname", async () => {
  const { adapter, runner } = createAdapter();
  const { sessionId } = await adapter.adoptNativeSession({}, { sessionId: "native" });

  await adapter.handle("session/prompt", { sessionId, prompt: "/login ghe.example.com" });

  const login = runner.calls.find((call) => call.type === "command" && call.args?.[0] === "login");
  assert.deepEqual(login.args, ["login", "--host", "https://ghe.example.com"]);
});
