# Copilot ACP Adapter

Dependency-free Node adapter that exposes an ACP v1 JSON-RPC/stdio interface for the configured GitHub Copilot CLI.

The adapter keeps the slash-command surface explicit so clients such as Emacs
`agent-shell.el` can discover commands even when they do not implement Copilot's
native terminal UI. It handles ACP/session commands itself, maps Copilot
management commands to real CLI subcommands, and forwards agent workflow
commands to Copilot prompt mode.

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
COPILOT_MODEL=auto
COPILOT_MODEL_NAME=Auto
COPILOT_MODELS=auto,claude-sonnet-5,gpt-5.4
COPILOT_MODEL_DISCOVERY_TIMEOUT_MS=3000
COPILOT_MODE=agent # agent, plan, or autopilot
GITHUB_ENTERPRISE_HOST=ghe.example.com
COPILOT_GITHUB_TOKEN=...
COPILOT_LOGIN_BROWSER=echo
COPILOT_LOGIN_HEADLESS=1
COPILOT_FORCE_TTY_DIRECT_COMMANDS=0
COPILOT_SCRIPT_STYLE=auto # only used when forcing TTY direct commands
COPILOT_CHANGELOG_TIMEOUT_MS=5000
# COPILOT_CHANGELOG_URL=https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md
COPILOT_SESSION_STATE_PATH=$HOME/.copilot/session-state
```

## ACP Methods

- `initialize`: returns `protocolVersion: 1`, `agentCapabilities`, `agentInfo`, and `authMethods`.
- `authenticate`: supports `github.com`, `github-enterprise`, and `api-key` method IDs.
- `newSession` or `session/new`: creates a session and returns `sessionId`.
- `session/list`: lists previous Copilot CLI conversations for the requested `cwd`.
- `session/load`: resumes a previous Copilot CLI conversation by session id.
- `prompt` or `session/prompt`: routes slash commands or forwards prompt text to Copilot, emitting output through `session/update`.
- `session/close`: drops adapter-side session state.
- `session/cancel`: accepted for clients that send cancellation notifications.
- `_commands/list`: extension method returning the adapter command catalog.

`prompt` accepts `prompt`, `text`, or `content` params.

## Login

The adapter advertises ACP `authMethods` and also intercepts `/login`:

- `/login`: shows login choices without assuming a provider.
- `/login github` or `/login github.com`: runs `copilot login --host https://github.com`.
- `/login enterprise ghe.example.com`: runs `copilot login --host https://ghe.example.com`.
- `/login api-key <token>`: stores the token in this adapter process for subsequent Copilot calls.

API keys can also be supplied with `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`.

Unauthenticated prompt execution will fail until one of those auth methods is available.

Provider-specific login commands run in headless mode by default by setting
`BROWSER=echo` and `CI=1` for the Copilot login subprocess. In Emacs this
should display a copyable device-flow URL and code, for example
`https://github.com/login/device`. Set `COPILOT_LOGIN_HEADLESS=0` if you
explicitly want Copilot CLI to try opening a local browser.

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

The adapter asks Copilot's native ACP server for its filtered model list before
advertising models to `agent-shell`, so administrator-disabled models should be
omitted from `M-x agent-shell-set-session-model`. To set the initial model
explicitly:

```elisp
(add-to-list 'agent-shell-github-environment
             "COPILOT_MODEL=claude-sonnet-5")
(add-to-list 'agent-shell-github-environment
             "COPILOT_MODEL_NAME=Claude Sonnet 5")
```

The adapter passes `COPILOT_MODEL` to Copilot as `--model <id>` for prompts.
If `COPILOT_MODEL=auto`, the header shows `Auto`; the adapter cannot know which
server-side model Copilot eventually picks unless Copilot exposes that choice.
Use `COPILOT_MODELS` as a comma-separated or JSON array override to skip native
ACP discovery. If discovery fails or times out, the adapter only advertises
`auto` plus the current configured model, avoiding a broad static catalog that
may include administrator-disabled models.
The session mode defaults to `Agent` and can be changed from the `agent-shell`
mode menu when available.

By default, `agent-shell` starts sessions at the project root. To start Copilot
in the current Emacs `default-directory` instead, for example after `M-x cd` into
a subdirectory, add:

```elisp
(setq agent-shell-cwd-function
      (lambda ()
        default-directory))
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

All commands from `AGENTS.md` are advertised to the ACP client:

- Agent Environment: `/init`, `/agent`, `/skills`, `/mcp`, `/plugin`
- Agents/Subagents: `/model`, `/delegate`, `/fleet`, `/autopilot`, `/tasks`
- Code: `/ide`, `/diff`, `/pr`, `/review`, `/security-review`, `/rubber-duck`, `/lsp`, `/terminal-setup`
- Permissions: `/allow-all`, `/add-dir`, `/list-dirs`, `/cwd`, `/reset-allowed-tools`
- Session: `/resume`, `/rename`, `/context`, `/usage`, `/session`, `/compact`, `/share`, `/remote`, `/copy`, `/rewind`
- Help: `/help`, `/changelog`, `/feedback`, `/diagnose`, `/theme`, `/statusline`, `/footer`, `/update`, `/version`, `/experimental`, `/memory`, `/clear`, `/instructions`, `/app`
- Other: `/ask`, `/chronicle`, `/env`, `/exit`, `/keep-alive`, `/limits`, `/login`, `/logout`, `/new`, `/plan`, `/research`, `/restart`, `/search`, `/settings`, `/subagents`, `/user`, `/voice`

Routing is adapter-owned rather than a proxy to `copilot --acp`:

- Adapter-native: `/help`, `/model`, `/autopilot`, `/cwd`, `/add-dir`, `/list-dirs`, `/allow-all`, `/reset-allowed-tools`, `/resume`, `/rename`, `/session`, `/new`, `/clear`, `/login`, `/logout`, `/settings`, `/skills` project listing, `/subagents`, and `/exit`.
- Direct Copilot CLI subcommands: `/init`, `/skills add/remove/list --json`, `/mcp`, `/plugin`, `/update`, and `/version`.
- Copilot prompt mode: remaining agent workflow commands such as `/review`, `/diff`, `/plan`, `/research`, `/delegate`, `/tasks`, and normal prompts.

`session/new`'s `cwd` parameter is treated as the client-provided working
directory. In Emacs agent-shell, this is controlled by
`agent-shell-cwd-function`; when the client does not send a cwd, the adapter
uses its startup directory.

The adapter advertises ACP session listing/loading and reads Copilot CLI
conversation metadata from `$COPILOT_HOME/session-state` or
`COPILOT_SESSION_STATE_PATH`. `session/list` mirrors Copilot's ACP behavior by
returning completed conversations whose stored workspace `cwd` matches the
requested cwd. `session/load` maps the selected id to subsequent Copilot prompt
calls via `--resume=<id>`.
During `session/load`, the adapter also replays user and assistant messages from
Copilot's `events.jsonl` as ACP history updates so clients can render the stored
conversation before it continues.

`/subagents` is implemented natively because Copilot exposes it only as an
interactive UI command. The adapter discovers project-defined agents from
`.github/agents` under the session cwd first. If none are found there, it falls
back to `.github/agents` at the git root. It then overlays the documented
per-agent model settings from `COPILOT_SETTINGS_PATH` or
`$COPILOT_HOME/settings.json`:

```text
/subagents
/subagents explore
/subagents set explore claude-sonnet-5 high long_context
/subagents unset explore
/settings subagents.agents.explore gpt-5.4
/settings unset subagents.agents.explore
```

`/skills` with no arguments, or `/skills list`, uses the same cwd-first then
git-root fallback for project skills. It checks `.github/skills/`,
`.agents/skills/`, and `.claude/skills/`. Other `/skills` subcommands are
delegated to the Copilot CLI.

Prompt-mode calls for new adapter sessions include a stable `--session-id` so
follow-up prompts share Copilot session state. `/new` and `/clear` rotate that
Copilot session id. Loaded conversations and `/resume <id>` use Copilot's
`--resume=<id>` path so turns append to the existing conversation.

Direct Copilot CLI subcommands use ordinary subprocess pipes by default. If a
future Copilot command only emits useful output from a terminal, set
`COPILOT_FORCE_TTY_DIRECT_COMMANDS=1` to run those commands through `script`.
The adapter auto-detects util-linux and BSD/macOS `script` syntax, and falls
back to plain subprocess execution if `script` fails with terminal/ioctl errors.
You can override detection with `COPILOT_SCRIPT_STYLE=util-linux`,
`COPILOT_SCRIPT_STYLE=bsd`, or `COPILOT_SCRIPT_STYLE=none`.

## License

Apache-2.0. See [LICENSE](LICENSE).
