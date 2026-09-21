import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { NativeAcpBackend } from "../src/native-acp-backend.js";
import { assertCompletedSubagentEvidence, completionEvidence, readSubagentCompletions } from "../src/subagent-reports.js";

const enabled = process.env.COPILOT_LIVE_TEST === "1";
const scenarioTimeout = Number(process.env.COPILOT_LIVE_TIMEOUT_MS || 120000);
const adapterBin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "copilot-acp-adapter.js");
const CLOSE_GRACE_MS = 1000;
const CLOSE_TERM_MS = 1000;
const CLOSE_KILL_MS = 1000;

test("LIVE: adapter and optional native ACP record strict subagent evidence", { skip: !enabled, timeout: scenarioTimeout * 2 + 20000 }, async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "copilot-acp-live-subagent-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  makeFixture(fixture);

  const requestedParent = process.env.COPILOT_LIVE_PARENT_MODEL || "gpt-5.6-terra";
  const requestedSubagent = process.env.COPILOT_LIVE_SUBAGENT_MODEL || "gpt-5.6-luna";
  const config = loadConfig(process.env);
  const paths = [{ mode: "adapter", launch: () => launchAdapter(fixture, scenarioTimeout) }];
  if (process.env.COPILOT_LIVE_COMPARE_NATIVE === "1") {
    paths.push({ mode: "native", launch: () => launchNative(fixture, scenarioTimeout, config) });
  }

  const results = [];
  for (const path of paths) {
    let client;
    try {
      // Launch and clean up one path at a time: a failed second launch must not
      // leave the first persistent ACP process behind.
      client = path.launch();
      results.push(await runScenario(path.mode, client, fixture, config, requestedParent, requestedSubagent, scenarioTimeout));
    } catch (error) {
      results.push(failedScenario(path.mode, error, requestedParent, requestedSubagent));
    } finally {
      await client?.close();
    }
  }

  for (const result of results) console.log(JSON.stringify(result));
  const failures = results.filter((result) => result.error);
  if (failures.length) {
    throw new AggregateError(
      failures.map((result) => new Error(`${result.mode} session=${result.sessionId || "unknown"}: ${result.error}`)),
      "Live subagent evidence verification failed",
    );
  }
});

function makeFixture(fixture) {
  mkdirSync(join(fixture, ".github", "agents"), { recursive: true });
  writeFileSync(join(fixture, "package.json"), '{"private":true,"type":"module","scripts":{"test":"node --test test.js"}}');
  writeFileSync(join(fixture, "test.js"), 'import assert from "node:assert/strict"; assert.equal(1, 1);');
  writeFileSync(
    join(fixture, ".github", "agents", "test-diagnostician.agent.md"),
    "---\nname: test-diagnostician\ndescription: Runs the isolated test suite without changing files.\ntools:\n  - shell\n---\nRun exactly npm test with no additional flags. Do not delegate. Do not edit files.\n",
  );
}

async function runScenario(mode, client, cwd, config, requestedParent, requestedSubagent, timeoutMs) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const diagnostic = scenarioDiagnostic(mode, requestedParent, requestedSubagent);
  try {
    await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "copilot-acp-live-compare", version: "1" } }, deadline);
    client.notify("initialized", {});
    const created = await client.request("session/new", { cwd, mcpServers: [] }, deadline);
    diagnostic.sessionId = created.sessionId;
    await client.request("session/set_model", { sessionId: diagnostic.sessionId, modelId: requestedParent }, deadline);
    await client.request("session/prompt", {
      sessionId: diagnostic.sessionId,
      prompt: [{
        type: "text",
        text: `Delegate synchronously to test-diagnostician with model ${requestedSubagent}. Do not run tests yourself.`,
      }],
    }, deadline);

    const call = client.toolCalls.find((item) => item.rawInput?.agent_type === "test-diagnostician");
    assert.ok(call, evidence(diagnostic, client, "no test-diagnostician tool_call observed"));
    diagnostic.toolCallId = call.toolCallId || null;
    diagnostic.observed.requestedModel = call.rawInput?.model ?? null;

    const events = await waitForJournal(config, diagnostic.sessionId, [call.toolCallId], deadline);
    const completion = completionEvidence(events.get(call.toolCallId));
    if (completion) {
      diagnostic.observed.evidence = "subagent.completed";
      diagnostic.observed.firstDispatchedModel = completion.firstDispatchedModel || null;
      diagnostic.observed.explicitModelOverride = completion.explicitModelOverride || null;
    } else {
      diagnostic.observed.evidence = "unavailable";
    }

    const report = client.reports.find((item) => item._meta?.toolCallId === call.toolCallId);
    if (report) recordReport(diagnostic, report);
    if (mode === "adapter") {
      assertAdapterReport(report, call, completion, diagnostic, client);
    }

    // Record every observed value before strict model checks. This makes an
    // alias/routing mismatch diagnosable instead of losing journal evidence.
    diagnostic.mismatches = modelMismatches(diagnostic, requestedSubagent);
    assert.equal(call.rawInput?.model, requestedSubagent, evidence(diagnostic, client, "delegation requested-model mismatch"));
    assertCompletedSubagentEvidence(events.get(call.toolCallId), {
      toolCallId: call.toolCallId,
      agentName: "test-diagnostician",
      requestedModel: requestedSubagent,
      firstDispatchedModel: requestedSubagent,
      explicitModelOverride: requestedSubagent,
    });
    assert.equal(client.deniedPermissions.length, 0, evidence(diagnostic, client, "native requested a permission; it was cancelled"));
    return successfulScenario(diagnostic);
  } catch (error) {
    diagnostic.mismatches = modelMismatches(diagnostic, requestedSubagent);
    error.diagnostic = diagnostic;
    error.sessionId = diagnostic.sessionId;
    throw error;
  }
}

function assertAdapterReport(report, call, completion, diagnostic, client) {
  assert.ok(report, evidence(diagnostic, client, "adapter emitted no correlated subagent-dispatch-report"));
  const meta = report._meta;
  assert.equal(meta.activity, "subagent-dispatch-report", evidence(diagnostic, client, "adapter report activity mismatch"));
  assert.equal(meta.toolCallId, call.toolCallId, evidence(diagnostic, client, "adapter report toolCallId mismatch"));
  assert.equal(meta.requestedModel, call.rawInput?.model, evidence(diagnostic, client, "adapter report requestedModel mismatch"));
  assert.equal(meta.evidence, completion ? "subagent.completed" : "unavailable", evidence(diagnostic, client, "adapter report evidence mismatch"));
  assert.equal(meta.firstDispatchedModel, completion?.firstDispatchedModel || "unknown", evidence(diagnostic, client, "adapter report firstDispatchedModel mismatch"));
  assert.equal(meta.explicitModelOverride, completion?.explicitModelOverride || null, evidence(diagnostic, client, "adapter report explicitModelOverride mismatch"));
  assert.equal(meta.mismatch, Boolean(completion?.firstDispatchedModel && call.rawInput?.model && completion.firstDispatchedModel !== call.rawInput.model), evidence(diagnostic, client, "adapter report mismatch flag mismatch"));
}

function recordReport(diagnostic, report) {
  const meta = report._meta;
  diagnostic.observed.report = {
    activity: meta.activity ?? null,
    toolCallId: meta.toolCallId ?? null,
    requestedModel: meta.requestedModel ?? null,
    firstDispatchedModel: meta.firstDispatchedModel ?? null,
    explicitModelOverride: meta.explicitModelOverride ?? null,
    evidence: meta.evidence ?? null,
    mismatch: meta.mismatch ?? null,
  };
}

function scenarioDiagnostic(mode, requestedParent, requestedSubagent) {
  return {
    mode,
    sessionId: null,
    toolCallId: null,
    requestedParent,
    requestedSubagent,
    observed: {
      requestedModel: null,
      firstDispatchedModel: null,
      explicitModelOverride: null,
      evidence: null,
      report: null,
    },
    mismatches: null,
  };
}

function modelMismatches(diagnostic, requestedSubagent) {
  return {
    requested: diagnostic.observed.requestedModel !== null && diagnostic.observed.requestedModel !== requestedSubagent,
    firstDispatched: diagnostic.observed.firstDispatchedModel !== null && diagnostic.observed.firstDispatchedModel !== requestedSubagent,
    override: diagnostic.observed.explicitModelOverride !== null && diagnostic.observed.explicitModelOverride !== requestedSubagent,
  };
}

function successfulScenario(diagnostic) {
  return { ...diagnostic, status: "passed" };
}

function failedScenario(mode, error, requestedParent, requestedSubagent) {
  const diagnostic = error.diagnostic || scenarioDiagnostic(mode, requestedParent, requestedSubagent);
  return { ...diagnostic, status: "failed", error: error.message, sessionId: error.sessionId || diagnostic.sessionId };
}

async function waitForJournal(config, sessionId, toolCallIds, signal) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal.aborted) throw signal.reason;
    const events = readSubagentCompletions({ sessionStatePath: config.copilotSessionStatePath, sessionId, toolCallIds });
    if (events.size === toolCallIds.length || attempt === 2) return events;
    await delay(250, signal);
  }
}

function launchNative(cwd, requestTimeout, config) {
  return new BackendClient(new NativeAcpBackend({
    command: config.copilotCommand,
    args: config.copilotAcpArgs,
    cwd,
    transport: "fifo",
    requestTimeoutMs: requestTimeout,
    env: childEnv(cwd),
    spawnImpl: spawnDetached,
  }));
}

function launchAdapter(cwd, requestTimeout) {
  return new ProcessClient(process.execPath, [adapterBin], cwd, requestTimeout, {
    COPILOT_BACKEND: "native-acp",
    COPILOT_ACP_TRANSPORT: "fifo",
    ...childEnv(cwd),
  });
}

function spawnDetached(command, args, options) {
  return spawn(command, args, { ...options, detached: process.platform !== "win32" });
}

function childEnv(cwd) {
  return {
    COPILOT_CWD: cwd,
    COPILOT_AUTO_UPDATE: "false",
    COPILOT_LIVE_TEST: "0",
    COPILOT_LIVE_COMPARE_NATIVE: "0",
  };
}

class BackendClient {
  constructor(backend) {
    this.backend = backend;
    this.toolCalls = [];
    this.reports = [];
    this.deniedPermissions = [];
    this.closePromise = null;
    backend.sendToClient = (message) => this.receive(message);
  }

  receive(message) {
    observe(this, message);
    if (message?.id === undefined || !message.method) return;
    if (message.method === "session/request_permission") {
      this.deniedPermissions.push(message);
      this.backend.forwardClientMessage({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" }, reason: "live test denies permissions" } });
      return;
    }
    this.backend.forwardClientMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }

  request(method, params, signal) {
    return raceAbort(this.backend.request(method, params), signal);
  }

  notify(method, params) {
    this.backend.notify(method, params);
  }

  close() {
    if (!this.closePromise) this.closePromise = this.closeImpl();
    return this.closePromise;
  }

  async closeImpl() {
    const error = new Error("live native ACP client closed");
    this.backend.rejectAll(error);
    const child = this.backend.child;
    try {
      this.backend.connection?.output?.end?.();
    } catch {
      // A broken FIFO is already being torn down.
    }
    if (child) await closeChildTree(child);
    this.backend.cleanupFifo();
  }
}

class ProcessClient {
  constructor(command, args, cwd, timeout, env) {
    this.child = spawnDetached(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.timeout = timeout;
    this.nextId = 1;
    this.pending = new Map();
    this.toolCalls = [];
    this.reports = [];
    this.deniedPermissions = [];
    this.closePromise = null;

    let buffered = "";
    const fail = (error) => this.rejectAll(error);
    this.child.on("error", fail);
    this.child.stdin.on("error", fail);
    this.child.stdout.on("error", fail);
    this.child.stderr.on("data", () => {}); // Drain stderr without retaining potentially sensitive output.
    this.child.on("close", (code, signal) => fail(new Error(`adapter exited code=${code}${signal ? ` signal=${signal}` : ""}`)));
    this.child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          fail(new Error(`invalid adapter JSON: ${error.message}`));
          return;
        }
        this.handleMessage(message);
      }
    });
  }

  handleMessage(message) {
    observe(this, message);
    if (message.method === "session/request_permission") {
      this.deniedPermissions.push(message);
      this.reply(message.id, { outcome: { outcome: "cancelled" }, reason: "live test denies permissions" });
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.replyError(message.id, -32601, `Method not found: ${message.method}`);
    }
  }

  send(message) {
    if (!this.child.stdin.writable) throw new Error("adapter stdin is unavailable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  reply(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  replyError(id, code, message) {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method, params, signal) {
    const id = this.nextId++;
    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out ${method}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
    return raceAbort(pending, signal);
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  close() {
    if (!this.closePromise) this.closePromise = this.closeImpl();
    return this.closePromise;
  }

  async closeImpl() {
    this.rejectAll(new Error("live adapter client closed"));
    try {
      this.child.stdin.end();
    } catch {
      // The adapter can already have exited or closed stdin.
    }
    await closeChildTree(this.child);
  }
}

function observe(client, message) {
  const update = message.params?.update;
  if (message.method === "session/update" && update?.sessionUpdate === "tool_call") {
    client.toolCalls.push(update);
  }
  if (message.method === "session/update" && update?._meta?.activity === "subagent-dispatch-report") {
    client.reports.push(update);
  }
}

function evidence(diagnostic, client, problem) {
  return `${problem}; mode=${diagnostic.mode} session=${diagnostic.sessionId || "unknown"} requestedParent=${diagnostic.requestedParent} requestedSubagent=${diagnostic.requestedSubagent} actualRequested=${diagnostic.observed.requestedModel || "unknown"} actualFirstDispatched=${diagnostic.observed.firstDispatchedModel || "unknown"} actualOverride=${diagnostic.observed.explicitModelOverride || "unknown"} toolCalls=${client.toolCalls.length} reports=${client.reports.length} deniedPermissions=${client.deniedPermissions.length}`;
}

function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error("scenario deadline exceeded"));
  return new Promise((resolve, reject) => {
    const onAbort = () => settle(reject, signal.reason || new Error("scenario deadline exceeded"));
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const settle = (callback, value) => {
      cleanup();
      callback(value);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
  });
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("scenario deadline exceeded"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason || new Error("scenario deadline exceeded"));
    const timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function closeChildTree(child) {
  await waitForClose(child, CLOSE_GRACE_MS);
  terminateProcessTree(child, "SIGTERM");
  await waitForClose(child, CLOSE_TERM_MS);
  // Send KILL to the group even if the adapter leader already exited: it may
  // have left a native ACP descendant in its detached process group.
  terminateProcessTree(child, "SIGKILL");
  await waitForClose(child, CLOSE_KILL_MS);
}

function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (closed) => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolve(closed);
    };
    child.once("close", onClose);
  });
}

function terminateProcessTree(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already dead is a successful cleanup outcome.
    }
  }
}

// These use a local Node child only; they exercise harness behavior without a
// Copilot process, credentials, network access, or a live ACP request.
test("offline live harness fixture gives the child test-only instructions", (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "copilot-acp-live-subagent-offline-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  makeFixture(fixture);
  const body = readFileSync(join(fixture, ".github", "agents", "test-diagnostician.agent.md"), "utf8");
  assert.match(body, /Run exactly npm test with no additional flags\. Do not delegate\. Do not edit files\./);
  assert.doesNotMatch(body, /delegate synchronously|do not run tests yourself/i);
});

test("offline live harness records and cancels ProcessClient permissions", async () => {
  const script = [
    'let buffer = "";',
    'process.stdin.on("data", (chunk) => {',
    '  buffer += chunk;',
    '  let newline;',
    '  while ((newline = buffer.indexOf("\\n")) >= 0) {',
    '    const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);',
    '    if (message.method === "session/prompt") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: {} }) + "\\n");',
    '    if (message.id === "permission-1") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\\n");',
    '  }',
    '});',
  ].join("\n");
  const client = new ProcessClient(process.execPath, ["-e", script], process.cwd(), 1000, {});
  try {
    assert.deepEqual(await client.request("session/prompt", {}, undefined), { ok: true });
    assert.equal(client.deniedPermissions.length, 1);
  } finally {
    await client.close();
  }
});

test("offline live harness close rejects pending requests and clears timers", async () => {
  const client = new ProcessClient(process.execPath, ["-e", "process.stdin.resume()"], process.cwd(), 1000, {});
  const pending = client.request("session/prompt", {}, undefined);
  const rejected = assert.rejects(pending, /live adapter client closed/);
  await client.close();
  await rejected;
  assert.equal(client.pending.size, 0);
});

test("offline live harness abort helpers reject immediately and clean up", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already aborted"));
  await assert.rejects(raceAbort(Promise.resolve("late"), controller.signal), /already aborted/);
  await assert.rejects(delay(1, controller.signal), /already aborted/);

  const pending = new AbortController();
  const delayed = delay(1000, pending.signal);
  pending.abort(new Error("cancelled"));
  await assert.rejects(delayed, /cancelled/);
});
