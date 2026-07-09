import assert from "node:assert/strict";
import { test } from "node:test";
import { CopilotRunner, buildPtyCommand, detectScriptStyle, isPtyWrapperFailure } from "../src/copilot-runner.js";

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
