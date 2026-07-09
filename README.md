# Copilot ACP Adapter

Dependency-free Node adapter that exposes an ACP v1 JSON-RPC/stdio interface and forwards prompts, including Copilot slash commands, to the configured GitHub Copilot CLI.

The adapter keeps the slash-command surface explicit so clients such as Emacs `agent-shell.el` can discover commands even when they do not implement Copilot's native terminal UI.

## Usage

```sh
npm start
```

By default the adapter runs the installed Copilot CLI in non-interactive mode:
`copilot --allow-all-tools --silent --no-color -p <prompt>`.

Install the official GitHub Copilot CLI first:

```sh
curl -fsSL https://gh.io/copilot-install | PREFIX="$HOME/.local" bash
export PATH="$HOME/.local/bin:$PATH"
copilot --version
```

This adapter has been smoke-tested with GitHub Copilot CLI `1.0.69`.

Configuration is environment-based:

```sh
COPILOT_COMMAND=$HOME/.local/bin/copilot
COPILOT_ARGS='["--allow-all-tools", "--silent", "--no-color"]'
COPILOT_TRANSPORT=prompt # prompt, stdin, argv, or command
GITHUB_ENTERPRISE_HOST=ghe.example.com
COPILOT_GITHUB_TOKEN=...
COPILOT_LOGIN_BROWSER=echo
COPILOT_LOGIN_HEADLESS=1
```

## ACP Methods

- `initialize`: returns `protocolVersion: 1`, `agentCapabilities`, `agentInfo`, and `authMethods`.
- `authenticate`: supports `github.com`, `github-enterprise`, and `api-key` method IDs.
- `newSession` or `session/new`: creates a session and returns `sessionId`.
- `prompt` or `session/prompt`: forwards prompt text to Copilot, preserving slash commands, and emits output through `session/update`.
- `session/close`: drops adapter-side session state.
- `session/cancel`: accepted for clients that send cancellation notifications.
- `_commands/list`: extension method returning the adapter command catalog.

`prompt` accepts `prompt`, `text`, or `content` params.

## Login

The adapter advertises ACP `authMethods` and also intercepts `/login`:

- `/login github` or `/login github.com`: runs `copilot login --host https://github.com`.
- `/login enterprise ghe.example.com`: runs `copilot login --host https://ghe.example.com`.
- `/login api-key <token>`: stores the token in this adapter process for subsequent Copilot calls.

API keys can also be supplied with `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`.

Unauthenticated prompt execution will fail until one of those auth methods is available.

Interactive `/login` runs in headless mode by default by setting `BROWSER=echo`
and `CI=1` for the Copilot login subprocess. In Emacs this should display a
copyable device-flow URL and code, for example `https://github.com/login/device`.
Set `COPILOT_LOGIN_HEADLESS=0` if you explicitly want Copilot CLI to try opening
a local browser.

## Emacs `agent-shell.el`

`agent-shell` uses newline-delimited JSON for ACP traffic. The adapter auto-detects
that framing and replies in the same format.

Configure the GitHub Copilot agent to use this adapter instead of Copilot CLI's
built-in `--acp` mode:

```elisp
(require 'agent-shell)
(require 'agent-shell-github)

(setq agent-shell-github-acp-command
      '("node" "/home/jai/copilot_acp_adapter/bin/copilot-acp-adapter.js"))

(setq agent-shell-github-environment
      '("COPILOT_COMMAND=/home/jai/.local/bin/copilot"
        "COPILOT_TRANSPORT=prompt"
        "COPILOT_ARGS=[\"--allow-all-tools\",\"--silent\",\"--no-color\"]"))
```

For token auth, add this to the environment list:

```elisp
(add-to-list 'agent-shell-github-environment
             "COPILOT_GITHUB_TOKEN=github_pat_...")
```

Restart any existing Copilot agent-shell buffer/process after changing this
configuration.

Then run:

```text
M-x agent-shell-github-start-copilot
```

If the buffer stays on `Loading`, check `*Messages*` and any
`acp-client-stderr(...)` buffer. The first startup phase should complete after
the adapter replies to `initialize` and `session/new`.

## Slash Commands

All commands from `AGENTS.md` are listed and passed through:

- Agent Environment: `/init`, `/agent`, `/skills`, `/mcp`, `/plugin`
- Agents/Subagents: `/model`, `/delegate`, `/fleet`, `/autopilot`, `/tasks`
- Code: `/ide`, `/diff`, `/pr`, `/review`, `/security-review`, `/rubber-duck`, `/lsp`, `/terminal-setup`
- Permissions: `/allow-all`, `/add-dir`, `/list-dirs`, `/cwd`, `/reset-allowed-tools`
- Session: `/resume`, `/rename`, `/context`, `/usage`, `/session`, `/compact`, `/share`, `/remote`, `/copy`, `/rewind`
- Help: `/help`, `/changelog`, `/feedback`, `/diagnose`, `/theme`, `/statusline`, `/footer`, `/update`, `/version`, `/experimental`, `/memory`, `/clear`, `/instructions`, `/app`
- Other: `/ask`, `/chronicle`, `/env`, `/exit`, `/keep-alive`, `/limits`, `/login`, `/logout`, `/new`, `/plan`, `/research`, `/restart`, `/search`, `/settings`, `/subagents`, `/user`, `/voice`

## License

Apache-2.0. See [LICENSE](LICENSE).
