import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CopilotAcpAdapter } from "../src/adapter.js";

function createAdapter() {
  const settingsDir = mkdtempSync(join(tmpdir(), "copilot-acp-settings-"));
  const sessionStateDir = mkdtempSync(join(tmpdir(), "copilot-acp-session-state-"));
  const calls = [];
  const notifications = [];
  const runner = {
    calls,
    async runPrompt(prompt, options) {
      calls.push({ type: "prompt", prompt, options });
      return { ok: true, exitCode: 0, stdout: `ran: ${prompt}`, stderr: "" };
    },
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
  const adapter = new CopilotAcpAdapter({
    config: {
      cwd: "/tmp",
      copilotCommand: "/home/jai/.local/bin/copilot",
      copilotArgs: ["--allow-all-tools", "--model", "ignored-base-model"],
      copilotModel: "claude-sonnet-5",
      copilotModelName: "Claude Sonnet 5",
      copilotModels: ["auto", "claude-sonnet-5", "gpt-5.4", "gemini-3.5-flash"],
      copilotMode: "agent",
      githubHost: "https://github.com",
      enterpriseHost: "",
      apiKey: "",
      loginBrowser: "echo",
      loginHeadless: true,
      copilotSettingsPath: join(settingsDir, "settings.json"),
      copilotSessionStatePath: sessionStateDir,
    },
    runner,
    notify(method, params) {
      notifications.push({ method, params });
    },
  });
  return {
    adapter,
    runner,
    notifications,
    settingsPath: join(settingsDir, "settings.json"),
    sessionStateDir,
  };
}

function writeStoredWorkspace(sessionStateDir, sessionId, fields) {
  const sessionDir = join(sessionStateDir, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const lines = [
    `id: ${sessionId}`,
    `cwd: ${fields.cwd}`,
    fields.name ? `name: ${fields.name}` : "",
    `updated_at: ${fields.updated_at}`,
  ].filter(Boolean);
  writeFileSync(join(sessionDir, "workspace.yaml"), `${lines.join("\n")}\n`);
  const eventsPath = join(sessionDir, "events.jsonl");
  writeFileSync(eventsPath, JSON.stringify({ type: "session.start" }) + "\n");
  const updatedAt = new Date(fields.updated_at);
  utimesSync(eventsPath, updatedAt, updatedAt);
}

test("initialize exposes ACP v1 capabilities and auth methods", async () => {
  const { adapter } = createAdapter();
  const result = await adapter.handle("initialize");
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.agentCapabilities._meta.slashCommandPassthrough, true);
  assert.equal(result.agentCapabilities.loadSession, true);
  assert.deepEqual(result.agentCapabilities.sessionCapabilities.list, {});
  assert.equal(result.authMethods.some((method) => method.id === "github-enterprise"), true);
});

test("session/new exposes model and mode metadata for agent-shell header", async () => {
  const { adapter } = createAdapter();
  const result = await adapter.handle("session/new", { cwd: "/repo" });

  assert.equal(result.models.currentModelId, "claude-sonnet-5");
  assert.equal(
    result.models.availableModels.find((model) => model.modelId === "claude-sonnet-5").name,
    "Claude Sonnet 5",
  );
  assert.deepEqual(
    result.models.availableModels.map((model) => model.modelId),
    ["auto", "claude-sonnet-5", "gpt-5.4", "gemini-3.5-flash"],
  );
  assert.equal(result.modes.currentModeId, "agent");
  assert.equal(result.modes.availableModes.some((mode) => mode.id === "plan"), true);
});

test("session/list returns stored conversations for the requested cwd", async () => {
  const { adapter, sessionStateDir } = createAdapter();
  writeStoredWorkspace(sessionStateDir, "older", {
    cwd: "/repo",
    name: "Older session",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  writeStoredWorkspace(sessionStateDir, "newer", {
    cwd: "/repo",
    name: "Newer session",
    updated_at: "2026-01-02T00:00:00.000Z",
  });
  writeStoredWorkspace(sessionStateDir, "other", {
    cwd: "/other",
    name: "Other session",
    updated_at: "2026-01-03T00:00:00.000Z",
  });

  const result = await adapter.handle("session/list", { cwd: "/repo" });

  assert.deepEqual(result.sessions, [
    {
      sessionId: "newer",
      cwd: "/repo",
      title: "Newer session",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    {
      sessionId: "older",
      cwd: "/repo",
      title: "Older session",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
});

test("session/load resumes prompts with Copilot resume flag", async () => {
  const { adapter, runner, sessionStateDir } = createAdapter();
  writeStoredWorkspace(sessionStateDir, "stored-session", {
    cwd: "/repo",
    name: "Stored session",
    updated_at: "2026-01-01T00:00:00.000Z",
  });

  const loaded = await adapter.handle("session/load", {
    sessionId: "stored-session",
    cwd: "/repo",
    mcpServers: [],
  });
  await adapter.handle("session/prompt", {
    sessionId: loaded.sessionId,
    prompt: "continue",
  });

  assert.equal(loaded.sessionId, "stored-session");
  assert.equal(loaded.cwd, "/repo");
  assert.deepEqual(runner.calls[0].options.copilotArgs.slice(-1), ["--resume=stored-session"]);
  assert.equal(runner.calls[0].options.copilotArgs.includes("--session-id"), false);
});

test("session model and mode changes affect subsequent Copilot args", async () => {
  const { adapter, runner } = createAdapter();
  const { sessionId } = await adapter.handle("session/new", {});

  await adapter.handle("session/set_model", {
    sessionId,
    modelId: "gpt-5.4",
  });
  await adapter.handle("session/set_mode", {
    sessionId,
    modeId: "plan",
  });
  await adapter.handle("session/prompt", {
    sessionId,
    prompt: "hello",
  });

  assert.deepEqual(runner.calls[0].options.copilotArgs, [
    "--allow-all-tools",
    "--model",
    "gpt-5.4",
    "--mode",
    "plan",
    "--session-id",
    sessionId,
  ]);
});

test("direct Copilot commands use CLI subcommands instead of prompt mode", async () => {
  const { adapter, runner, notifications } = createAdapter();
  const { sessionId } = await adapter.handle("session/new", { cwd: "/repo" });
  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/mcp",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(runner.calls[0].type, "command");
  assert.deepEqual(runner.calls[0].args, ["mcp", "list"]);
  assert.equal(runner.calls[0].options.forceTty, false);
  assert.equal(result._meta.command.name, "/mcp");
  assert.equal(result._meta.handledBy, "copilot-command");
  assert.equal(
    notifications.some(
      (notification) =>
        notification.method === "session/update" &&
        notification.params.update.sessionUpdate === "available_commands_update",
    ),
    true,
  );
  assert.equal(
    notifications.some(
      (notification) =>
        notification.method === "session/update" &&
        notification.params.update.content?.text === "command: mcp list\n",
    ),
    true,
  );
});

test("skills list is handled natively from session cwd", async () => {
  const { adapter, runner, notifications } = createAdapter();
  const repo = mkdtempSync(join(tmpdir(), "copilot-acp-repo-"));
  const nested = join(repo, "packages", "app");
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(nested, ".github", "skills", "local-skill"), { recursive: true });
  writeFileSync(
    join(nested, ".github", "skills", "local-skill", "SKILL.md"),
    "---\nname: local-skill\ndescription: Local skill\n---\n",
  );

  const { sessionId } = await adapter.handle("session/new", { cwd: nested });
  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/skills",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(runner.calls.length, 0);
  assert.equal(result._meta.handledBy, "adapter");
  assert.equal(
    notifications.some(
      (notification) =>
        notification.method === "session/update" &&
        notification.params.update.content?.text.includes("local-skill:") &&
        notification.params.update.content?.text.includes("source: .github/skills/local-skill/SKILL.md"),
    ),
    true,
  );
});

test("skills management subcommands still use Copilot CLI", async () => {
  const { adapter, runner } = createAdapter();
  const { sessionId } = await adapter.handle("session/new", { cwd: "/repo" });
  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/skills add ./my-skill",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(runner.calls[0].type, "command");
  assert.deepEqual(runner.calls[0].args, ["skill", "add", "./my-skill"]);
  assert.equal(result._meta.handledBy, "copilot-command");
});

test("agent workflow slash commands still pass through prompt mode", async () => {
  const { adapter, runner } = createAdapter();
  const { sessionId } = await adapter.handle("session/new", { cwd: "/repo" });
  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/review",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(runner.calls[0].type, "prompt");
  assert.equal(runner.calls[0].prompt, "/review");
  assert.equal(result._meta.command.name, "/review");
});

test("subagents command is handled natively instead of prompt mode", async () => {
  const { adapter, runner, notifications } = createAdapter();
  const { sessionId } = await adapter.handle("session/new", { cwd: "/repo" });
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
  const { sessionId } = await adapter.handle("session/new", { cwd: "/repo" });
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

  const { sessionId } = await adapter.handle("session/new", { cwd: nested });
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

  const { sessionId } = await adapter.handle("session/new", { cwd: nested });
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

  const { sessionId } = await adapter.handle("session/new", { cwd: repo });
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
  const { sessionId } = await adapter.handle("session/new", { cwd: "/repo" });

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

test("native directory commands update session prompt args", async () => {
  const { adapter, runner, notifications } = createAdapter();
  const { sessionId } = await adapter.handle("session/new", { cwd: "/repo" });

  await adapter.handle("session/prompt", { sessionId, prompt: "/cwd src" });
  await adapter.handle("session/prompt", { sessionId, prompt: "/add-dir ../shared" });
  await adapter.handle("session/prompt", { sessionId, prompt: "hello" });

  assert.equal(runner.calls[0].options.cwd, "/repo/src");
  assert.deepEqual(runner.calls[0].options.copilotArgs.slice(-4), [
    "--add-dir",
    "/repo/shared",
    "--session-id",
    sessionId,
  ]);
  assert.equal(
    notifications.some(
      (notification) =>
        notification.method === "session/update" &&
        notification.params.update.content?.text.includes("Working directory set to /repo/src"),
    ),
    true,
  );
});

test("resume command uses Copilot resume flag for subsequent prompts", async () => {
  const { adapter, runner } = createAdapter();
  const { sessionId } = await adapter.handle("session/new", { cwd: "/repo" });

  await adapter.handle("session/prompt", { sessionId, prompt: "/resume existing-session" });
  await adapter.handle("session/prompt", { sessionId, prompt: "hello" });

  assert.deepEqual(runner.calls[0].options.copilotArgs.slice(-1), ["--resume=existing-session"]);
  assert.equal(runner.calls[0].options.copilotArgs.includes("--session-id"), false);
});

test("login api-key stores env in the session", async () => {
  const { adapter, runner } = createAdapter();
  const { sessionId } = await adapter.handle("session/new", {});
  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/login api-key test-token",
  });

  assert.equal(result.stopReason, "end_turn");
  await adapter.handle("session/prompt", { sessionId, prompt: "hello" });
  assert.equal(runner.calls[0].options.env.COPILOT_GITHUB_TOKEN, "test-token");
});

test("login github streams device-flow output to the session", async () => {
  const { adapter, notifications } = createAdapter();
  const { sessionId } = await adapter.handle("session/new", {});
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
  const { sessionId } = await adapter.handle("session/new", {});
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
