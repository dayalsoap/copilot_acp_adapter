import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGithubLoginCommand, parseLoginArgs } from "../src/auth.js";

const config = {
  copilotCommand: "/home/jai/.local/bin/copilot",
  githubHost: "https://github.com",
  enterpriseHost: "https://ghe.example.com",
  apiKey: "",
  loginBrowser: "echo",
  loginHeadless: true,
};

test("builds GitHub.com login command", () => {
  const login = parseLoginArgs("github", config);
  assert.deepEqual(buildGithubLoginCommand(login, config), {
    type: "copilot",
    ok: true,
    command: "/home/jai/.local/bin/copilot",
    args: ["login", "--host", "https://github.com"],
    env: { BROWSER: "echo", CI: "1" },
    message: "Starting GitHub authentication for https://github.com.",
  });
});

test("bare login asks the user to choose a login method", () => {
  const login = parseLoginArgs("", config);
  const command = buildGithubLoginCommand(login, config);
  assert.equal(command.ok, true);
  assert.equal(command.type, "choose");
  assert.match(command.message, /\/login github/);
  assert.match(command.message, /\/login enterprise <hostname>/);
});

test("builds GitHub Enterprise login command", () => {
  const login = parseLoginArgs("enterprise ghe.internal", config);
  const command = buildGithubLoginCommand(login, config);
  assert.equal(command.ok, true);
  assert.deepEqual(command.args, ["login", "--host", "https://ghe.internal"]);
});

test("api key login produces env without shelling out", () => {
  const login = parseLoginArgs("api-key secret-token", config);
  const command = buildGithubLoginCommand(login, config);
  assert.equal(command.ok, true);
  assert.equal(command.type, "api-key");
  assert.equal(command.env.COPILOT_GITHUB_TOKEN, "secret-token");
  assert.equal(command.env.GITHUB_TOKEN, "secret-token");
});
