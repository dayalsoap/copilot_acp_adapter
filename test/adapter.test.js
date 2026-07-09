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
      options.onStdout?.("To authenticate, visit https://github.com/login/device and enter code ABCD-1234.\n");
      return { ok: true, exitCode: 0, stdout: "logged in", stderr: "" };
    },
  };
  const adapter = new CopilotAcpAdapter({
    config: {
      cwd: "/tmp",
      copilotCommand: "/home/jai/.local/bin/copilot",
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

test("prompt passes slash commands through to Copilot runner", async () => {
  const { adapter, runner, notifications } = createAdapter();
  const { sessionId } = await adapter.handle("session/new", { cwd: "/repo" });
  const result = await adapter.handle("session/prompt", {
    sessionId,
    prompt: "/skills list",
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(runner.calls[0].type, "prompt");
  assert.equal(runner.calls[0].prompt, "/skills list");
  assert.equal(result._meta.command.name, "/skills");
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
        notification.params.update.content?.text === "ran: /skills list",
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
