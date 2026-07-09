import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPtyCommand, detectScriptStyle } from "../src/copilot-runner.js";

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
