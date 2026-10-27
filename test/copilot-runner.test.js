import assert from "node:assert/strict";
import { test } from "node:test";
import { CopilotRunner, runProcess } from "../src/copilot-runner.js";

test("runCommand runs the command and captures its output", async () => {
  const runner = new CopilotRunner({ cwd: process.cwd(), requestTimeoutMs: 0 });
  const chunks = [];
  const result = await runner.runCommand("/bin/echo", ["direct-ok"], {
    onStdout: (text) => chunks.push(text),
  });

  assert.equal(result.ok, true);
  assert.match(result.stdout, /direct-ok/);
  assert.match(chunks.join(""), /direct-ok/);
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
