import { spawn } from "node:child_process";

export class CopilotRunner {
  constructor(config) {
    this.config = config;
  }

  runCommand(command, args, options = {}) {
    const config = { ...this.config, ...options };
    const env = { ...process.env, ...(options.env || {}) };

    return runProcess({
      command,
      args,
      input: options.input || "",
      cwd: config.cwd,
      env,
      timeoutMs: Number(options.timeoutMs ?? config.requestTimeoutMs ?? 0),
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      signal: options.signal,
    });
  }
}

export function runProcess({
  command,
  args,
  input,
  cwd,
  env,
  timeoutMs,
  onStdout,
  onStderr,
  signal,
  forceKillAfterMs = 2000,
}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    let forceKillTimer = null;
    let aborted = false;
    let timedOut = false;
    let abortMessage = "";

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      signal?.removeEventListener?.("abort", onAbort);
    };

    const terminate = (reason, { cancelled = false, timeout = false } = {}) => {
      aborted ||= cancelled;
      timedOut ||= timeout;
      abortMessage = abortReasonMessage(reason) || "Process cancelled.";
      killChild(child, "SIGTERM");
      if (forceKillAfterMs > 0) {
        forceKillTimer = setTimeout(() => {
          killChild(child, "SIGKILL");
        }, forceKillAfterMs);
      }
    };

    const onAbort = () => {
      terminate(signal.reason, { cancelled: true });
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        terminate(`Timed out after ${timeoutMs}ms.`, { timeout: true });
      }, timeoutMs);
    }

    if (signal?.aborted) {
      terminate(signal.reason, { cancelled: true });
    } else {
      signal?.addEventListener?.("abort", onAbort, { once: true });
    }

    // StringDecoder semantics: a multi-byte character split across two chunks is
    // held back rather than emitted as replacement characters.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (text) => {
      stdout += text;
      onStdout?.(text);
    });

    child.stderr.on("data", (text) => {
      stderr += text;
      onStderr?.(text);
    });

    child.stdin.on("error", () => {
      // The process may exit between cancellation and stdin writes.
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr || error.message,
        error: error.message,
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({
        ok: !aborted && !timedOut && exitCode === 0,
        aborted,
        timedOut,
        exitCode,
        signal,
        stdout,
        stderr: aborted || timedOut
          ? stderr
          : stderr ||
          (exitCode === 0
            ? ""
            : `${command} exited with code ${exitCode}. If this is Copilot, run /login or set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN.`),
        error: aborted || timedOut ? abortMessage : undefined,
      });
    });

    if (input && !signal?.aborted) {
      child.stdin.write(input);
    }
    if (!child.stdin.destroyed) {
      child.stdin.end();
    }
  });
}

function killChild(child, signal) {
  if (!child.pid) {
    return;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to signalling the child itself below.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The process may have already exited.
  }
}

function abortReasonMessage(reason) {
  if (!reason) {
    return "";
  }
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
}

