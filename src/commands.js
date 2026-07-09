export const COMMAND_GROUPS = Object.freeze({
  "Agent Environment": ["/init", "/agent", "/skills", "/mcp", "/plugin"],
  "Agents/Subagents": ["/model", "/delegate", "/fleet", "/autopilot", "/tasks"],
  Code: [
    "/ide",
    "/diff",
    "/pr",
    "/review",
    "/security-review",
    "/rubber-duck",
    "/lsp",
    "/terminal-setup",
  ],
  Permissions: [
    "/allow-all",
    "/add-dir",
    "/list-dirs",
    "/cwd",
    "/reset-allowed-tools",
  ],
  Session: [
    "/resume",
    "/rename",
    "/context",
    "/usage",
    "/session",
    "/compact",
    "/share",
    "/remote",
    "/copy",
    "/rewind",
  ],
  Help: [
    "/help",
    "/changelog",
    "/feedback",
    "/diagnose",
    "/theme",
    "/statusline",
    "/footer",
    "/update",
    "/version",
    "/experimental",
    "/memory",
    "/clear",
    "/instructions",
    "/app",
  ],
  Other: [
    "/ask",
    "/chronicle",
    "/env",
    "/exit",
    "/keep-alive",
    "/limits",
    "/login",
    "/logout",
    "/new",
    "/plan",
    "/research",
    "/restart",
    "/search",
    "/settings",
    "/subagents",
    "/user",
    "/voice",
  ],
});

export const COMMANDS = Object.freeze(
  Object.entries(COMMAND_GROUPS).flatMap(([group, commands]) =>
    commands.map((name) => ({ name, group })),
  ),
);

export const COMMAND_SET = new Set(COMMANDS.map((command) => command.name));

const COMMAND_DESCRIPTIONS = Object.freeze({
  "/login": "Authenticate with GitHub.com, GitHub Enterprise, or an API key",
  "/logout": "Clear or end the current Copilot authentication state",
  "/skills": "Inspect or manage Copilot skills",
  "/agents": "Inspect or manage agents",
  "/subagents": "Inspect or manage subagents",
  "/help": "Show Copilot command help",
  "/model": "Inspect or change the active model",
  "/review": "Request a code review",
  "/security-review": "Request a security-focused code review",
  "/diff": "Inspect current changes",
  "/pr": "Create or inspect pull requests",
  "/cwd": "Inspect or change the working directory",
  "/add-dir": "Add an allowed workspace directory",
  "/list-dirs": "List allowed workspace directories",
  "/plan": "Create or enter planning workflow",
  "/research": "Run research workflow",
  "/settings": "Inspect or manage adapter-supported Copilot settings",
  "/ask": "Ask a question without applying changes",
  "/exit": "Exit the current Copilot session",
});

export function parseSlashCommand(input) {
  const text = String(input ?? "").trimStart();
  if (!text.startsWith("/")) {
    return null;
  }

  const [name, ...args] = text.split(/\s+/);
  return {
    name,
    args,
    rawArgs: text.slice(name.length).trimStart(),
    supported: COMMAND_SET.has(name),
  };
}

export function parseCommandArgs(rawArgs) {
  const text = String(rawArgs || "").trim();
  if (!text) {
    return [];
  }

  return text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(unquoteArg) || [];
}

export function listCommands() {
  return COMMANDS.map((command) => ({ ...command }));
}

export function listAvailableCommands() {
  return COMMANDS.map((command) => ({
    name: command.name.slice(1),
    description:
      COMMAND_DESCRIPTIONS[command.name] ||
      `Run Copilot ${command.group.toLowerCase()} command ${command.name}`,
    input: { hint: "optional command arguments" },
  }));
}

function unquoteArg(arg) {
  if (
    (arg.startsWith('"') && arg.endsWith('"')) ||
    (arg.startsWith("'") && arg.endsWith("'"))
  ) {
    return arg.slice(1, -1);
  }
  return arg;
}
