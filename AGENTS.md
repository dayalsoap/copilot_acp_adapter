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

## Implementation Handoff

This repository is a dependency-free Node.js ACP adapter. It exposes an ACP v1 JSON-RPC/stdio server and proxies prompts, permission requests, session lifecycle, configuration, and Copilot-owned slash commands to a persistent native `copilot --acp` subprocess. Native ACP is the only backend; the older `copilot -p` prompt backend was removed on 2026-10-27 (see `CLEANUP-REPORT.md`).

### What the adapter adds over native

- Headless auth: `/login` (GitHub.com, Enterprise, API key), ACP `authenticate` for `github.com` / `github-enterprise` / `api-key`, `/logout`, and a native backend relaunch on credential changes. Native `/login` is interactive-only.
- Helpers native doesn't run over ACP: `/help`, `/diff`, `/settings` (via `copilot config`, plus the per-subagent JSON bridge), `/subagents`, `/changelog` (including `/changelog summarize`, which becomes a native prompt), `/experimental`, `/keep-alive`, `/version`, `/update`. A helper runs only while native hasn't advertised the same name.
- Session plumbing: bare `/exit` maps to native `session/close`; unadvertised slash commands are rejected; native and helper commands are merged; `available_commands_update` is re-sent after the `session/new` result.
- Transport: FIFO transport for the nested native process, auto-detected framing, and whitespace-normalized `session/list` titles.
- Reporting: subagent dispatch reports and model-mention reports from the session journal. Skill/subagent activity is left to Copilot's own tool-call, title, and plan updates.

Re-check these against the installed CLI with `node scripts/probe-native-acp.mjs` (read-only, no prompts; writes the ignored `scripts/native-acp-probe.json`).

### Local Tooling State

- Node.js is available and the package uses native `node --test`; no npm dependencies are required.
- On this Mac, the official GitHub Copilot CLI is installed at `/opt/homebrew/bin/copilot`; `/home/jai/.local/bin/copilot` remains the Linux fallback.
- The installed Copilot CLI was verified as `GitHub Copilot CLI 1.0.104`.
- The adapter defaults to `/home/jai/.local/bin/copilot` when present, otherwise `copilot`.
- Native ACP initialization and proxy transport smoke testing succeeded on this machine; full prompt testing still requires authentication.

### Project Layout

- `bin/copilot-acp-adapter.js`: executable entry point.
- `src/server.js`: stdio JSON-RPC server wiring.
- `src/json-rpc.js`: `Content-Length` and newline-delimited JSON-RPC framing.
- `src/native-acp-backend.js`: persistent `copilot --acp` subprocess, FIFO/stdio transport, request forwarding and restart.
- `src/adapter.js`: local helper commands, adopted native session state, command merging, auth handling, and reporting.
- `src/commands.js`: canonical slash-command catalog from this file plus helper command descriptions.
- `src/auth.js`: `/login` parsing and Copilot CLI login command construction.
- `src/copilot-runner.js`: subprocess wrapper for login, `copilot config`, `git diff`, and direct CLI commands.
- `src/config.js`: environment config and default Copilot binary detection.
- `src/session-title.js`: `session/list` title whitespace normalization.
- `src/settings.js`, `src/project-agents.js`: the `/subagents` and per-subagent `/settings` bridge.
- `src/model-reports.js`, `src/subagent-reports.js`: journal-based reporting.
- `scripts/probe-native-acp.mjs`: read-only snapshot of what native ACP advertises.
- `test/*.test.js`: native Node tests, including the fake-peer subprocess integration test.

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
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | node ./bin/copilot-acp-adapter.js
```

Snapshot what native ACP advertises (no prompts, no model usage):

```sh
node scripts/probe-native-acp.mjs
```

### Runtime Defaults

The adapter runs Copilot as a persistent native ACP backend:

```sh
/home/jai/.local/bin/copilot --acp --no-color
```

Relevant environment variables:

- `COPILOT_COMMAND`: override Copilot executable.
- `COPILOT_ACP_ARGS`: shell-like string or JSON array for the persistent native backend; defaults to `--acp --no-color`. Startup flags such as `--model` or `--agent` go here.
- `COPILOT_ACP_TRANSPORT`: native ACP subprocess transport; defaults to `fifo`. `stdio` is available for debugging, but nested `copilot --acp` stdio exits when the adapter itself is launched with piped stdin.
- `COPILOT_ACP_REQUEST_TIMEOUT_MS`: native ACP request timeout; defaults to 15000 ms.
- `GITHUB_ENTERPRISE_HOST` or `GHE_HOST`: Enterprise host for `/login enterprise`.
- `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`: token auth for headless use.
- `COPILOT_REQUEST_TIMEOUT_MS`: optional timeout for helper subprocesses.
- `COPILOT_SETTINGS_PATH`, `COPILOT_SESSION_STATE_PATH`: settings file for the subagent bridge and session journals for reporting.
- `COPILOT_CHANGELOG_URL`: optional override for the official Copilot CLI changelog source.
- `COPILOT_CHANGELOG_TIMEOUT_MS`: changelog fetch timeout; defaults to 5000 ms.

### Auth Behavior

- Bare `/login` shows login choices instead of assuming GitHub.com.
- `/login github` and `/login github.com` run `copilot login --host https://github.com`.
- `/login enterprise ghe.example.com` runs `copilot login --host https://ghe.example.com`.
- `/login api-key <token>` stores the token as `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` and relaunches the native backend with it.
- Login runs headless by default with `BROWSER=echo` and `CI=1`, so Emacs receives a copyable device-flow URL/code instead of Copilot trying to open a browser on the host running the adapter.
- ACP `authenticate` supports method IDs `github.com`, `github-enterprise`, and `api-key`.
- ACP `logout` only clears adapter-held token environment. Copilot CLI does not expose a top-level `copilot logout`; `/logout` is an interactive slash command.

### Known Gaps / Next Work

- Authenticate before true end-to-end prompt testing. Use `/home/jai/.local/bin/copilot login`, `/login api-key <token>` through the adapter, or export `COPILOT_GITHUB_TOKEN`.
- Confirm exact ACP schema compatibility against the target Emacs `agent-shell.el` client. The adapter intentionally supports common aliases like `newSession`/`session/new` and `prompt`/`session/prompt`, but the client may require stricter names or update shapes.
- `acp.el` uses newline-delimited JSON, not `Content-Length` framing. The adapter now auto-detects incoming framing and replies with newline JSON for Emacs clients.
- `agent-shell` defaults `agent-shell-cwd` to the project root. To start in the current Emacs directory, set `agent-shell-cwd-function` to `(lambda () default-directory)` before starting the shell.
- The richer `agent-shell` header comes from `session/new` `models` and `modes` fields. Native 1.0.104 sends both and the adapter passes them through unchanged.
- Validate permission round-trips in the real Emacs `agent-shell` client, especially `/add-dir`, `/allow-all`, and tool approvals.
- The offline fake-peer integration test covers negotiation, permissions, command snapshots, loading, closing, and `/changelog summarize`. Model/subagent live testing remains opt-in.
- Native command descriptions come from Copilot notifications; the static catalog in `commands.js` only supplies helper descriptions now.

## Native ACP update (2026-10-07)

- Copilot CLI 1.0.104 is installed on the Mac via `/opt/homebrew/bin/copilot` (updated 2026-10-27).
- Native command snapshots and enabled skills are authoritative; add only
  implemented text helpers. Reject unadvertised slash commands after discovery.
- Preserve client initialize capabilities and native configuration metadata.
  Never launch a second model-discovery process. Forward configuration
  requests and `/autopilot` to native unchanged.
- Adopt loaded native sessions and close upstream sessions on `/exit` or close.
- Simple settings use `copilot config`; complex per-subagent settings still
  require the JSON bridge, as explicitly confirmed by the current CLI.
- Keep bounded journal dispatch evidence until native raw events are verified
  to provide the exact first-dispatched-model fields.
- `npm test` includes a fake-peer subprocess integration test. Use read-only
  `/context` for protocol smoke testing without model usage.

## Verbal model reports

- Natural-language model mentions trigger a visible report even without delegation.
- Distinguish the user's mention, the session model selected/requested from
  Copilot, observed model-call/usage events, and correlated subagent completions.
- Report actual agent/model evidence when available; otherwise label the values
  sent to Copilot as requested. Never use model prose or the desired model as proof.
- Read only bounded journal bytes appended since the prompt began; ignore
  historical/child events and decline attribution for overlapping prompts.
- Keep prompt text and model routing unchanged. Offline checks cover direct
  skills, mismatched agents/models, and unavailable evidence.
