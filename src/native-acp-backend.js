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
    this.connection = new JsonRpcConnection(stdout, stdin);
    this.connection.framing = "newline";
    this.connection.on("message", (message) => this.handleBackendMessage(message));
    this.connection.start();
    this.child.stderr?.on("data", (chunk) => this.emit("stderr", chunk.toString()));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", (code, signal) => {
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
      this.connection.send(message);
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
        this.sendToClient(
          forwardedRequest.transformResponse
            ? forwardedRequest.transformResponse(response)
            : response,
        );
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

  rejectAll(error) {
    for (const [id, pending] of this.pendingBackendRequests) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
      this.pendingBackendRequests.delete(id);
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
