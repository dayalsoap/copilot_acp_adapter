The Copilot ACP adapter is lacking many features compared to using the Github Copilot CLI directly. For example, /skills and /agents aren't supported with the AACP adapter.

Having a well-functioning ACP client is important as I primarily use copilot via Emacs agent-shell.el.

Can we create an ACP client/adapter for copilot that supports all the /commands?

Agent Environment:  /init ,  /agent ,  /skills ,  /mcp ,  /plugin
Agents/Subagents:  /model ,  /delegate ,  /fleet ,  /autopilot ,  /tasks
Code:  /ide ,  /diff ,  /pr ,  /review ,  /security-review ,  /rubber-duck ,  /lsp ,  /terminal-setup
Permissions:  /allow-all ,  /add-dir ,  /list-dirs ,  /cwd ,  /reset-allowed-tools
Session:  /resume ,  /rename ,  /context ,  /usage ,  /session ,  /compact ,  /share ,  /remote ,  /copy ,  /rewind
Help:  /help ,  /changelog ,  /feedback ,  /diagnose ,  /theme ,  /statusline ,  /footer ,  /update ,  /version ,  /experimental ,  /memory ,  /clear ,  /instructions ,  /app
Other:  /ask ,  /chronicle ,  /env ,  /exit ,  /keep-alive ,  /limits ,  /login ,  /logout ,  /new ,  /plan ,  /research ,  /restart ,  /search ,  /settings ,  /subagents ,  /user ,  /voice

For login, I need to be able to support logging in via github.com and github enterprise, as well as potentially providing an API key.

## Current Implementation Handoff

This repository is currently a dependency-free Node.js ACP adapter scaffold. It exposes an ACP v1-style JSON-RPC/stdio server and forwards prompts, including slash commands, to the installed GitHub Copilot CLI.

### Local Tooling State

- Node.js is available and the package uses native `node --test`; no npm dependencies are required.
- The official GitHub Copilot CLI is installed at `/home/jai/.local/bin/copilot`.
- The installed Copilot CLI was verified as `GitHub Copilot CLI 1.0.69`.
- The adapter defaults to `/home/jai/.local/bin/copilot` when present, otherwise `copilot`.
- The current machine was not authenticated when live prompt testing was last attempted.

### Project Layout

- `bin/copilot-acp-adapter.js`: executable entry point.
- `src/server.js`: stdio JSON-RPC server wiring.
- `src/json-rpc.js`: `Content-Length` and newline-delimited JSON-RPC framing.
- `src/adapter.js`: ACP method dispatch, session state, command advertisement, auth handling.
- `src/commands.js`: canonical slash-command catalog from this file plus command descriptions.
- `src/auth.js`: `/login` parsing and Copilot CLI login command construction.
- `src/copilot-runner.js`: subprocess wrapper for invoking Copilot CLI.
- `src/config.js`: environment config and default Copilot binary detection.
- `test/*.test.js`: native Node tests for catalog, auth, adapter behavior, and JSON-RPC framing.

### Verified Commands

Run the unit tests:

```sh
npm test
```

Verify Copilot CLI installation:

```sh
/home/jai/.local/bin/copilot --version
```

Inspect the installed CLI slash-command list:

```sh
/home/jai/.local/bin/copilot help commands
```

Smoke-test adapter initialization over JSON-RPC:

```sh
node -e 'const m=JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize"}); process.stdout.write(`Content-Length: ${Buffer.byteLength(m)}\r\n\r\n${m}`)' | node ./bin/copilot-acp-adapter.js
```

### Runtime Defaults

The adapter currently runs Copilot prompts as:

```sh
/home/jai/.local/bin/copilot --allow-all-tools --silent --no-color -p "<prompt>"
```

Relevant environment variables:

- `COPILOT_COMMAND`: override Copilot executable.
- `COPILOT_ARGS`: shell-like string or JSON array; defaults to `--allow-all-tools --silent --no-color`.
- `COPILOT_TRANSPORT`: `prompt` by default; also supports `stdin`, `argv`, and `command`.
- `GITHUB_ENTERPRISE_HOST` or `GHE_HOST`: Enterprise host for `/login enterprise`.
- `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`: token auth for headless use.
- `COPILOT_REQUEST_TIMEOUT_MS`: optional subprocess timeout.

### Auth Behavior

- `/login github` and `/login github.com` run `copilot login --host https://github.com`.
- `/login enterprise ghe.example.com` runs `copilot login --host https://ghe.example.com`.
- `/login api-key <token>` stores the token in adapter session env as `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN`.
- Login runs headless by default with `BROWSER=echo` and `CI=1`, so Emacs receives a copyable device-flow URL/code instead of Copilot trying to open a browser on the host running the adapter.
- ACP `authenticate` supports method IDs `github.com`, `github-enterprise`, and `api-key`.
- ACP `logout` currently only clears adapter-held token environment. Copilot CLI 1.0.69 does not expose a top-level `copilot logout`; `/logout` is an interactive slash command.

### Known Gaps / Next Work

- Authenticate before true end-to-end prompt testing. Use `/home/jai/.local/bin/copilot login`, `/login api-key <token>` through the adapter, or export `COPILOT_GITHUB_TOKEN`.
- Confirm exact ACP schema compatibility against the target Emacs `agent-shell.el` client. The adapter intentionally supports common aliases like `newSession`/`session/new` and `prompt`/`session/prompt`, but the client may require stricter names or update shapes.
- `acp.el` uses newline-delimited JSON, not `Content-Length` framing. The adapter now auto-detects incoming framing and replies with newline JSON for Emacs clients.
- Validate whether running every slash command through `copilot -p "/command"` behaves like interactive slash commands. If some commands require a persistent TTY session, the runner will need a persistent interactive Copilot process instead of one subprocess per prompt.
- Add integration tests once authentication is available. Start with `/help`, `/skills`, `/agent`, `/mcp`, and a plain prompt.
- Replace generic command descriptions in `src/commands.js` with the exact text from `copilot help commands` if client UX needs richer command menus.
- Decide whether this adapter should wrap Copilot CLI's built-in `--acp` mode, proxy it, or continue using direct prompt subprocesses with custom command discovery.
