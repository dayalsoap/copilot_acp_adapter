import assert from "node:assert/strict";
import { test } from "node:test";
import { CopilotAcpAdapter } from "../src/adapter.js";

function createAdapter() {
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
      copilotMode: "agent",
      githubHost: "https://github.com",
      enterpriseHost: "",
      apiKey: "",
      loginBrowser: "echo",
      loginHeadless: true,
    },
    runner,
    notify(method, params) {
      notifications.push({ method, params });
    },
  });
  return { adapter, runner, notifications };
}

test("initialize exposes ACP v1 capabilities and auth methods", async () => {
  const { adapter } = createAdapter();
  const result = await adapter.handle("initialize");
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.agentCapabilities._meta.slashCommandPassthrough, true);
  assert.equal(result.authMethods.some((method) => method.id === "github-enterprise"), true);
});

test("session/new exposes model and mode metadata for agent-shell header", async () => {
  const { adapter } = createAdapter();
  const result = await adapter.handle("session/new", { cwd: "/repo" });

  assert.equal(result.models.currentModelId, "claude-sonnet-5");
  assert.equal(result.models.availableModels[0].name, "Claude Sonnet 5");
  assert.equal(result.modes.currentModeId, "agent");
  assert.equal(result.modes.availableModes.some((mode) => mode.id === "plan"), true);
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
    prompt: "/skills",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(runner.calls[0].type, "command");
  assert.deepEqual(runner.calls[0].args, ["skill", "list"]);
  assert.equal(runner.calls[0].options.forceTty, true);
  assert.equal(result._meta.command.name, "/skills");
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
        notification.params.update.content?.text === "command: skill list\n",
    ),
    true,
  );
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
