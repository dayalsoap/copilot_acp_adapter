import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CopilotRunner,
  buildPtyCommand,
  detectScriptStyle,
  isPtyWrapperFailure,
  runProcess,
  withJsonEventArgs,
} from "../src/copilot-runner.js";

test("builds util-linux script command when requested", () => {
  assert.deepEqual(
    buildPtyCommand("/bin/copilot", ["skill", "list"], {
      COPILOT_SCRIPT_STYLE: "util-linux",
    }),
    {
      command: "script",
      args: ["-q", "-e", "-c", "/bin/copilot skill list", "/dev/null"],
    },
  );
});

test("builds BSD script command when requested", () => {
  assert.deepEqual(
    buildPtyCommand("/bin/copilot", ["skill", "list"], {
      COPILOT_SCRIPT_STYLE: "bsd",
    }),
    {
      command: "script",
      args: ["-q", "/dev/null", "/bin/copilot", "skill", "list"],
    },
  );
});

test("can disable script pty wrapping", () => {
  assert.equal(
    buildPtyCommand("/bin/copilot", ["skill", "list"], {
      COPILOT_SCRIPT_STYLE: "none",
    }),
    null,
  );
});

test("detectScriptStyle honors explicit override", () => {
  assert.equal(detectScriptStyle({ COPILOT_SCRIPT_STYLE: "bsd" }), "bsd");
});

test("classifies socket ioctl failures as pty wrapper failures", () => {
  assert.equal(
    isPtyWrapperFailure({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "tcgetattr/ioctl: operation not supported on socket",
    }),
    true,
  );
  assert.equal(
    isPtyWrapperFailure({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: "spawn script EPERM",
    }),
    true,
  );
});

test("forceTty runs direct command when pty wrapping is unavailable", async () => {
  const runner = new CopilotRunner({ cwd: process.cwd(), requestTimeoutMs: 0 });
  const result = await runner.runCommand(
    "/bin/echo",
    ["fallback-ok"],
    {
      forceTty: true,
      env: { COPILOT_SCRIPT_STYLE: "none" },
    },
  );

  assert.equal(result.ok, true);
  assert.match(result.stdout, /fallback-ok/);
});

test("prompt args default to Copilot JSON event streaming", async () => {
  assert.deepEqual(
    withJsonEventArgs(["--allow-all-tools", "--silent", "--no-color", "--output-format", "text"]),
    ["--allow-all-tools", "--no-color", "--output-format", "json", "--stream", "on"],
  );

  const runner = new CopilotRunner({
    copilotCommand: "/bin/echo",
    copilotTransport: "prompt",
    copilotArgs: ["--allow-all-tools", "--silent", "--no-color"],
    cwd: process.cwd(),
    requestTimeoutMs: 0,
  });
  const result = await runner.runPrompt("hello");

  assert.equal(result.ok, true);
  assert.match(result.stdout, /--output-format json --stream on -p hello/);
  assert.equal(result.stdout.includes("--silent"), false);
});

test("runProcess abort signal terminates the child process", async () => {
  const controller = new AbortController();
  const resultPromise = runProcess({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 0,
    signal: controller.signal,
    forceKillAfterMs: 50,
  });

  controller.abort(new Error("User cancelled"));
  const result = await resultPromise;

  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(result.error, "User cancelled");
});
