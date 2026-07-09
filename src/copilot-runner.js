import { spawn } from "node:child_process";

export class CopilotRunner {
  constructor(config) {
    this.config = config;
  }

  runPrompt(prompt, options = {}) {
    const config = { ...this.config, ...options };
    const env = { ...process.env, ...(config.env || {}) };
    const timeoutMs = Number(config.requestTimeoutMs || 0);

    let args = [...(config.copilotArgs || [])];
    if (config.copilotTransport === "prompt") {
      args = [...args, "-p", prompt];
    }

    if (config.copilotTransport === "argv") {
      args = [...args, prompt];
    }

    if (config.copilotTransport === "command") {
      const slash = String(prompt).trimStart().split(/\s+/)[0];
      args = [...args, slash, String(prompt).trimStart().slice(slash.length).trimStart()];
    }

    return runProcess({
      command: config.copilotCommand,
      args,
      input: config.copilotTransport === "stdin" ? `${prompt}\n` : "",
      cwd: config.cwd,
      env,
      timeoutMs,
    });
  }

  runCommand(command, args, options = {}) {
    const config = { ...this.config, ...options };
    return runProcess({
      command,
      args,
      input: options.input || "",
      cwd: config.cwd,
      env: { ...process.env, ...(options.env || {}) },
      timeoutMs: Number(options.timeoutMs ?? config.requestTimeoutMs ?? 0),
    });
  }
}

export function runProcess({ command, args, input, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
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
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        ok: exitCode === 0,
        exitCode,
        signal,
        stdout,
        stderr:
          stderr ||
          (exitCode === 0
            ? ""
            : `${command} exited with code ${exitCode}. If this is Copilot, run /login or set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN.`),
      });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}
