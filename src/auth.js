export function parseLoginArgs(rawArgs, config) {
  const parts = String(rawArgs || "").trim().split(/\s+/).filter(Boolean);
  const mode = parts[0] || "github";

  if (mode === "enterprise" || mode === "ghe") {
    return {
      mode: "enterprise",
      host: parts[1] || config.enterpriseHost,
      token: findFlagValue(parts, "--api-key") || findFlagValue(parts, "--token"),
    };
  }

  if (mode === "api-key" || mode === "token") {
    return {
      mode: "api-key",
      host: parts[1]?.startsWith("-") ? config.githubHost : parts[1] || config.githubHost,
      token: findFlagValue(parts, "--api-key") || findFlagValue(parts, "--token") || parts[1],
    };
  }

  return {
    mode: "github",
    host: mode === "github" ? parts[1] || config.githubHost : mode,
    token: findFlagValue(parts, "--api-key") || findFlagValue(parts, "--token"),
  };
}

export function loginFromMethodId(methodId, config) {
  if (methodId === "github-enterprise") {
    return { mode: "enterprise", host: normalizeLoginHost(config.enterpriseHost) };
  }
  if (methodId === "api-key") {
    return { mode: "api-key", host: normalizeLoginHost(config.githubHost), token: config.apiKey };
  }
  return { mode: "github", host: normalizeLoginHost(config.githubHost) };
}

export function listAuthMethods(config) {
  return [
    {
      id: "github.com",
      type: "agent",
      name: "GitHub.com",
      description: "Authenticate with GitHub.com via the Copilot CLI device/browser flow.",
    },
    {
      id: "github-enterprise",
      type: "agent",
      name: "GitHub Enterprise",
      description:
        "Authenticate with GitHub Enterprise. Set GITHUB_ENTERPRISE_HOST or use `/login enterprise <hostname>`.",
    },
    {
      id: "api-key",
      type: "agent",
      name: "API key",
      description:
        "Use COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, or `/login api-key <token>`.",
    },
  ];
}

export function buildGithubLoginCommand(login, config) {
  if (login.mode === "api-key") {
    const token = login.token || config.apiKey;
    if (!token) {
      return {
        type: "api-key",
        ok: false,
        message:
          "API-key login requires COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, or `/login api-key <token>`.",
      };
    }

    return {
      type: "api-key",
      ok: true,
      env: {
        COPILOT_GITHUB_TOKEN: token,
        GITHUB_TOKEN: token,
        GH_TOKEN: token,
      },
      message: "API key loaded into this adapter process for subsequent Copilot CLI calls.",
    };
  }

  const host = normalizeLoginHost(login.host || config.githubHost);
  if (login.mode === "enterprise" && !host) {
    return {
      type: "gh",
      ok: false,
      message:
        "GitHub Enterprise login requires `/login enterprise <hostname>` or GITHUB_ENTERPRISE_HOST.",
    };
  }

  return {
    type: "copilot",
    ok: true,
    command: config.copilotCommand,
    args: ["login", "--host", host],
    env: config.loginHeadless
      ? {
          BROWSER: config.loginBrowser || "echo",
          CI: "1",
        }
      : {},
    message: `Starting GitHub authentication for ${host}.`,
  };
}

function normalizeLoginHost(host) {
  if (!host) {
    return "";
  }
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
}

export function buildLogoutCommand(config) {
  return {
    command: "",
    args: [],
  };
}

function findFlagValue(parts, flag) {
  const index = parts.indexOf(flag);
  if (index === -1) {
    return "";
  }
  return parts[index + 1] || "";
}
