import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcConnection } from "./json-rpc.js";

export class NativeAcpBackend extends EventEmitter {
  constructor({
    command,
    args = ["--acp", "--no-color"],
    cwd,
    env = {},
    transport = "stdio",
    sendToClient = () => {},
    spawnImpl = spawn,
    requestTimeoutMs = 15000,
  }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.transport = transport;
    this.sendToClient = sendToClient;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.connection = null;
    this.fifoDir = null;
    this.fifoStreams = [];
    this.nextUpstreamId = 1;
    this.nextClientId = 1;
    this.pendingBackendRequests = new Map();
    this.forwardedClientRequests = new Map();
    this.forwardedClientResponses = new Map();
    this.pendingDeliveries = new Set();
  }

  start() {
    if (this.child) {
      return;
    }

    if (this.transport === "fifo") {
      this.startFifo();
      return;
    }

    this.startStdio();
  }

  startStdio() {
    this.child = this.spawnImpl(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.attachChild(this.child.stdin, this.child.stdout);
  }

  startFifo() {
    this.fifoDir = mkdtempSync(join(tmpdir(), "copilot-acp-"));
    const inputPath = join(this.fifoDir, "in");
    const outputPath = join(this.fifoDir, "out");
    const mkfifo = spawnSync("mkfifo", [inputPath, outputPath]);
    if (mkfifo.status !== 0) {
      const message = mkfifo.stderr?.toString().trim() || mkfifo.error?.message || "mkfifo failed";
      this.cleanupFifo();
      throw new Error(`Failed to create Copilot ACP FIFOs: ${message}`);
    }

    this.child = this.spawnImpl("/bin/sh", [
      "-c",
      'exec "$@" <"$COPILOT_ACP_FIFO_IN" >"$COPILOT_ACP_FIFO_OUT"',
      "copilot-acp-backend",
      this.command,
      ...this.args,
    ], {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...this.env,
        COPILOT_ACP_FIFO_IN: inputPath,
        COPILOT_ACP_FIFO_OUT: outputPath,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    const stdin = createWriteStream(inputPath);
    const stdout = createReadStream(outputPath);
    this.fifoStreams = [stdin, stdout];
    this.attachChild(stdin, stdout);
  }

  attachChild(stdin, stdout) {
    const child = this.child;
    this.connection = new JsonRpcConnection(stdout, stdin);
    this.connection.framing = "newline";
    this.connection.on("message", (message) => {
      try {
        const result = this.handleBackendMessage(message);
        if (result?.catch) result.catch((error) => this.emit("backendError", error));
      } catch (error) {
        // `error` is special on EventEmitter and throws when unobserved.
        this.emit("backendError", error);
      }
    });
    this.connection.on("parseError", (error) => this.rejectAll(error));
    // Streams can fail independently of the ChildProcess (notably ENOENT and
    // broken FIFO/stdin). Reject waiting callers immediately rather than only
    // after their request timeout.
    stdin.on?.("error", (error) => this.rejectAll(error));
    stdout.on?.("error", (error) => this.rejectAll(error));
    this.connection.start();
    child.stderr?.on("data", (chunk) => this.emit("stderr", chunk.toString()));
    child.on("error", (error) => {
      if (this.child !== child) {
        return;
      }
      this.rejectAll(error);
    });
    child.on("close", (code, signal) => {
      // A restart has already replaced this child; its teardown is not our business.
      if (this.child !== child) {
        return;
      }
      const error = new Error(`Native Copilot ACP exited with code ${code}${signal ? ` signal ${signal}` : ""}`);
      setImmediate(() => this.rejectAll(error));
      this.child = null;
      this.connection = null;
      this.cleanupFifo();
    });
  }

  async request(method, params = {}) {
    this.start();
    const id = `adapter-${this.nextUpstreamId++}`;
    const message = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = Number(this.requestTimeoutMs || 0);

    return new Promise((resolve, reject) => {
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
            this.pendingBackendRequests.delete(id);
            reject(new Error(`Native Copilot ACP request timed out: ${method}`));
          }, timeoutMs)
        : null;
      this.pendingBackendRequests.set(id, { resolve, reject, timeout });
      try {
        this.connection.send(message);
      } catch (error) {
        this.pendingBackendRequests.delete(id);
        if (timeout) clearTimeout(timeout);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.start();
    this.connection.send({ jsonrpc: "2.0", method, params });
  }

  forwardClientMessage(message, transformResponse = null) {
    this.start();
    if (isResponse(message)) {
      return this.forwardClientResponse(message);
    }

    const forwarded = { ...message };
    if (message.id !== undefined) {
      forwarded.id = `client-${this.nextUpstreamId++}`;
      this.forwardedClientRequests.set(forwarded.id, {
        clientId: message.id,
        transformResponse,
      });
    }
    this.connection.send(forwarded);
    return true;
  }

  forwardClientResponse(message) {
    const backendId = this.forwardedClientResponses.get(message.id);
    if (backendId === undefined) {
      return false;
    }
    this.forwardedClientResponses.delete(message.id);
    this.connection.send({ ...message, id: backendId });
    return true;
  }

  handleBackendMessage(message) {
    if (isResponse(message)) {
      const pending = this.pendingBackendRequests.get(message.id);
      if (pending) {
        this.pendingBackendRequests.delete(message.id);
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
        if (message.error) {
          pending.reject(Object.assign(new Error(message.error.message || "Native ACP request failed"), {
            code: message.error.code,
            data: message.error.data,
          }));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      const forwardedRequest = this.forwardedClientRequests.get(message.id);
      if (forwardedRequest !== undefined) {
        this.forwardedClientRequests.delete(message.id);
        const response = { ...message, id: forwardedRequest.clientId };
        return this.deliverForwardedResponse(forwardedRequest, response);
      }
      return;
    }

    if (message?.method && message.id !== undefined) {
      const clientId = `native-${this.nextClientId++}`;
      this.forwardedClientResponses.set(clientId, message.id);
      this.sendToClient({ ...message, id: clientId });
      return;
    }

    this.sendToClient(message);
  }

  deliverForwardedResponse(forwarded, response) {
    let transformed;
    try {
      transformed = forwarded.transformResponse ? forwarded.transformResponse(response) : response;
    } catch (error) {
      this.emit("backendError", error);
      this.sendToClient(response);
      return Promise.resolve();
    }
    if (!transformed?.then) {
      this.sendToClient(transformed);
      return Promise.resolve();
    }
    const delivery = Promise.resolve(transformed)
      // Handle only transform rejection here. A client transport failure must
      // not cause a second send of the same native response.
      .then(
        (value) => this.sendToClient(value),
        (error) => {
          this.emit("backendError", error);
          return this.sendToClient(response);
        },
      )
      .catch((error) => this.emit("backendError", error))
      .finally(() => this.pendingDeliveries.delete(delivery));
    this.pendingDeliveries.add(delivery);
    return delivery;
  }

  async waitForDeliveries() {
    await Promise.allSettled([...this.pendingDeliveries]);
  }

  rejectAll(error) {
    for (const [id, pending] of this.pendingBackendRequests) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
      this.pendingBackendRequests.delete(id);
    }

    // Requests the client is still waiting on. Without this the client hangs
    // forever on a turn the backend will never answer.
    for (const [backendId, forwarded] of this.forwardedClientRequests) {
      this.forwardedClientRequests.delete(backendId);
      const response = {
        jsonrpc: "2.0",
        id: forwarded.clientId,
        error: {
          code: -32000,
          message: error.message || "Native Copilot ACP backend terminated",
        },
      };
      try {
        this.deliverForwardedResponse(forwarded, response);
      } catch {
        // A failing client transport must not stop the remaining rejections.
      }
    }

    // Responses the backend was waiting on can never be delivered now.
    this.forwardedClientResponses.clear();
  }

  async restart(env = {}) {
    this.env = { ...this.env, ...env };
    const child = this.child;
    if (!child) {
      return;
    }

    const closed = new Promise((resolve) => child.once("close", resolve));
    this.close();
    await Promise.race([closed, delay(2000)]);

    if (this.child === child) {
      this.child = null;
      this.connection = null;
    }
  }

  close() {
    this.child?.kill();
    this.cleanupFifo();
  }

  cleanupFifo() {
    for (const stream of this.fifoStreams) {
      stream.destroy?.();
    }
    this.fifoStreams = [];
    if (this.fifoDir) {
      rmSync(this.fifoDir, { recursive: true, force: true });
      this.fifoDir = null;
    }
  }
}

function isResponse(message) {
  return message && message.id !== undefined && !message.method;
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
