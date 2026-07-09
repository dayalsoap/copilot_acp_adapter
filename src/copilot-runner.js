import { spawn, spawnSync } from "node:child_process";

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

  async runCommand(command, args, options = {}) {
    const config = { ...this.config, ...options };
    const env = { ...process.env, ...(options.env || {}) };

    if (options.forceTty) {
      const ptyCommand = buildPtyCommand(command, args, env);
      if (ptyCommand) {
        const ptyResult = await runProcess({
          command: ptyCommand.command,
          args: ptyCommand.args,
          input: options.input || "",
          cwd: config.cwd,
          env,
          timeoutMs: Number(options.timeoutMs ?? config.requestTimeoutMs ?? 0),
        });

        if (!isPtyWrapperFailure(ptyResult)) {
          options.onStdout?.(ptyResult.stdout);
          options.onStderr?.(ptyResult.stderr);
          return ptyResult;
        }
      }
    }

    return runProcess({
      command,
      args,
      input: options.input || "",
      cwd: config.cwd,
      env,
      timeoutMs: Number(options.timeoutMs ?? config.requestTimeoutMs ?? 0),
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
  }
}

export function runProcess({ command, args, input, cwd, env, timeoutMs, onStdout, onStderr }) {
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
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
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

export function isPtyWrapperFailure(result) {
  if (result.ok) {
    return false;
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}\n${result.error || ""}`.toLowerCase();
  return [
    "illegal option",
    "tcgetattr",
    "ioctl",
    "operation not supported on socket",
    "inappropriate ioctl",
    "not a tty",
    "unexpected number of arguments",
    "eperm",
  ].some((pattern) => output.includes(pattern));
}

export function buildPtyCommand(command, args, env = process.env) {
  const style = detectScriptStyle(env);
  if (style === "none") {
    return null;
  }

  if (style === "bsd") {
    return {
      command: "script",
      args: ["-q", "/dev/null", command, ...args],
    };
  }

  return {
    command: "script",
    args: [
      "-q",
      "-e",
      "-c",
      [command, ...args].map(shellQuote).join(" "),
      "/dev/null",
    ],
  };
}

let cachedScriptStyle = null;

export function detectScriptStyle(env = process.env) {
  const override = env.COPILOT_SCRIPT_STYLE;
  if (["util-linux", "bsd", "none"].includes(override)) {
    return override;
  }

  if (cachedScriptStyle) {
    return cachedScriptStyle;
  }

  const result = spawnSync("script", ["--help"], {
    encoding: "utf8",
    env,
  });

  if (result.error?.code === "ENOENT") {
    cachedScriptStyle = "none";
    return cachedScriptStyle;
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  cachedScriptStyle = output.includes("--command") ? "util-linux" : "bsd";
  return cachedScriptStyle;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}
