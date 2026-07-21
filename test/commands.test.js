import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMAND_SET,
  listAvailableCommands,
  listCommands,
  parseSlashCommand,
} from "../src/commands.js";

test("catalog includes all AGENTS.md slash commands", () => {
  const expected = [
    "/init",
    "/agent",
    "/skills",
    "/mcp",
    "/plugin",
    "/model",
    "/delegate",
    "/fleet",
    "/autopilot",
    "/tasks",
    "/ide",
    "/diff",
    "/pr",
    "/review",
    "/security-review",
    "/rubber-duck",
    "/lsp",
    "/terminal-setup",
    "/allow-all",
    "/add-dir",
    "/list-dirs",
    "/cwd",
    "/reset-allowed-tools",
    "/resume",
    "/rename",
    "/context",
    "/usage",
    "/session",
    "/compact",
    "/share",
    "/remote",
    "/copy",
    "/rewind",
    "/help",
    "/changelog",
    "/feedback",
    "/diagnose",
    "/theme",
    "/statusline",
    "/footer",
    "/update",
    "/version",
    "/experimental",
    "/memory",
    "/clear",
    "/instructions",
    "/app",
    "/ask",
    "/chronicle",
    "/env",
    "/exit",
    "/keep-alive",
    "/limits",
    "/login",
    "/logout",
    "/new",
    "/plan",
    "/research",
    "/restart",
    "/search",
    "/settings",
    "/subagents",
    "/user",
    "/voice",
  ];

  assert.equal(listCommands().length, expected.length);
  for (const command of expected) {
    assert.equal(COMMAND_SET.has(command), true, command);
  }
});

test("parseSlashCommand preserves raw args and support status", () => {
  assert.deepEqual(parseSlashCommand("  /skills install foo"), {
    name: "/skills",
    args: ["install", "foo"],
    rawArgs: "install foo",
    supported: true,
  });

  assert.equal(parseSlashCommand("plain prompt"), null);
  assert.equal(parseSlashCommand("/not-real").supported, false);
});

test("available commands include discovered project skills", () => {
  const commands = listAvailableCommands([
    { name: "adapter-smoke-test", description: "Run the adapter smoke test" },
    { name: "help", description: "Must not replace the built-in command" },
  ]);

  assert.deepEqual(
    commands.find((command) => command.name === "adapter-smoke-test"),
    {
      name: "adapter-smoke-test",
      description: "Run the adapter smoke test",
      input: { hint: "optional skill arguments" },
    },
  );
  assert.equal(commands.filter((command) => command.name === "help").length, 1);
});
