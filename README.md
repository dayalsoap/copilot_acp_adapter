# Copilot ACP Adapter

Dependency-free Node adapter that sits between an ACP client (such as Emacs
`agent-shell.el`) and the GitHub Copilot CLI's own ACP server.

It runs a persistent native `copilot --acp` backend and proxies everything to
it: prompts, permission requests, session new/load/list/close, configuration
(model, mode, agent, allow-all), and every slash command Copilot advertises.
The adapter only adds what native ACP still lacks.

### What the adapter adds over native `copilot --acp`

- **Headless auth.** `/login` (GitHub.com, GitHub Enterprise, API key), ACP
  `authenticate` for `github.com` / `github-enterprise` / `api-key`, and
  `/logout`. Native `/login` is interactive-only and native auth expects
  client terminal-auth. A credential change relaunches the native backend.
- **Commands native doesn't run over ACP:** `/help` (native plus helper
  commands), `/diff`, `/settings` (via `copilot config`, plus a JSON bridge for
  per-subagent settings), `/subagents`, `/changelog`, `/experimental`,
  `/keep-alive`, `/version`, and `/update`. A helper only runs while native
  hasn't advertised a command with the same name; native wins collisions.
- **Session plumbing:** a bare `/exit` closes the native session; unadvertised
  slash commands are rejected instead of being sent to the model as text; the
  command menu merges native and helper commands; `available_commands_update`
  is re-sent after the `session/new` result so clients don't drop it.
- **Transport:** a FIFO transport for the nested native process (stdio exits
  when the adapter's own stdin is piped), auto-detected `Content-Length` or
  newline JSON framing, and whitespace-normalized `session/list` titles (native
  still returns titles with embedded newlines).
- **Reporting:** subagent dispatch reports and model-mention reports built
  from Copilot's session journal. Skill and subagent activity itself is shown
  through Copilot's own tool-call, title, and plan updates.

## Usage

```sh
npm start
```

The adapter runs the installed Copilot CLI as a persistent ACP backend:
`copilot --acp --no-color`. Copilot's native permission flow handles
filesystem/tool requests the same way as the stock Copilot ACP server.

Install the official GitHub Copilot CLI first:

```sh
curl -fsSL https://gh.io/copilot-install | PREFIX="$HOME/.local" bash
export PATH="$HOME/.local/bin:$PATH"
copilot --version
```

This adapter has been smoke-tested with GitHub Copilot CLI `1.0.104`.

To see exactly what the installed CLI's ACP server advertises (commands,
capabilities, auth methods, session metadata), run the read-only probe. It
sends no prompts and makes no model calls:

```sh
node scripts/probe-native-acp.mjs   # writes scripts/native-acp-probe.json
```

Configuration is environment-based:

```sh
COPILOT_COMMAND=$HOME/.local/bin/copilot
COPILOT_ACP_ARGS='["--acp", "--no-color"]' # add e.g. "--model", "gpt-5.4" here
COPILOT_ACP_TRANSPORT=fifo # fifo or stdio
COPILOT_ACP_REQUEST_TIMEOUT_MS=15000
GITHUB_ENTERPRISE_HOST=ghe.example.com
COPILOT_GITHUB_TOKEN=...
COPILOT_LOGIN_BROWSER=echo
COPILOT_LOGIN_HEADLESS=1
COPILOT_REQUEST_TIMEOUT_MS=0 # helper subprocesses (/diff, copilot config, ...)
COPILOT_CHANGELOG_TIMEOUT_MS=5000
# COPILOT_CHANGELOG_URL=https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md
COPILOT_SETTINGS_PATH=$HOME/.copilot/settings.json
COPILOT_SESSION_STATE_PATH=$HOME/.copilot/session-state
```

## ACP Methods

- `initialize`: forwarded to native with the client's own parameters; the
  result adds the adapter's `authMethods` and `_meta.backend`.
- `authenticate`: `github.com`, `github-enterprise`, and `api-key` are handled
  by the adapter; any other method ID (e.g. native `copilot-login`) is forwarded.
- `session/new`, `session/load`, `session/list`, `session/set_config_option`,
  `session/set_mode`, `session/set_model`: forwarded to native. `session/list`
  titles are whitespace-normalized.
- `prompt` or `session/prompt`: adapter helpers run locally; everything else,
  including advertised slash commands, is forwarded to native.
- `session/close` or `closeSession`: closes the native session and clears adapter-side state.
- `session/cancel`: cancels local helper work and is forwarded to native.
- `_commands/list`: extension method returning this session's merged command list.

`prompt` accepts `prompt`, `text`, or `content` params.

## Login

The adapter advertises ACP `authMethods` and also intercepts `/login`:

- `/login`: shows login choices without assuming a provider.
- `/login github` or `/login github.com`: runs `copilot login --host https://github.com`.
- `/login enterprise ghe.example.com`: runs `copilot login --host https://ghe.example.com`.
- `/login api-key <token>`: stores the token in this adapter process and relaunches the native backend with it.

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
        "COPILOT_ACP_ARGS=[\"--acp\",\"--no-color\"]"))
```

Native ACP owns model, mode, reasoning-effort, agent, and permission
configuration. The adapter passes Copilot's `configOptions`, `models`, and
`modes` through unchanged, including administrator-filtered model choices, and
forwards `session/set_config_option`, `session/set_mode`, and `/autopilot`
untouched. Copilot owns permission prompts.

To use Copilot without this adapter, use agent-shell's native command:

```elisp
(setq agent-shell-github-acp-command '("copilot" "--acp"))
```

The adapter remains useful for the additions listed at the top of this file.

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

The authoritative command list comes from Copilot's
`available_commands_update` notifications. Each notification replaces the
previous snapshot, including enabled skills discovered by Copilot. The adapter
adds only helpers it actually implements and re-sends the current snapshot
after session creation/loading so clients can register the session first.
It does not add local skills behind Copilot's filtering or advertise every
terminal command from `AGENTS.md`.

### Command routing

| Command | Adapter behavior |
| --- | --- |
| `/login` | Handles GitHub.com, GitHub Enterprise, and API-key authentication. Native ACP `copilot-login` authentication is forwarded. |
| `/logout` | Clears adapter-held tokens and restarts the backend. OAuth logout still requires the interactive CLI. |
| `/help` | Displays this session's native commands plus implemented helpers. |
| `/changelog` | Fetches the official Copilot CLI changelog. `/changelog summarize [version\|last N\|since V]` sends the selected notes to Copilot as an ordinary prompt. |
| `/diff` | Runs local `git diff`. |
| `/settings` | Runs `copilot config --list`; arguments use `copilot config`, with `unset KEY` translated to `--rm KEY`. |
| `/subagents` | Reads/writes complex per-subagent settings and discovers project agents. |
| `/settings subagents.agents.NAME ...` | Retains the complex-setting JSON bridge because `copilot config` explicitly refuses these values. |
| `/experimental`, `/keep-alive` | Read/change the corresponding setting through `copilot config`. Restart for startup settings to take effect. |
| `/exit` | A bare `/exit` closes the native ACP session and clears adapter tracking. |
| `/version`, `/update` | Run the corresponding CLI command directly. |

For example:

```text
/settings
/settings footer.showQuota off
/settings unset theme
/settings --repo --list --json
/subagents set explore inherit high long_context
```

The config CLI requires a file named `settings.json`; `COPILOT_SETTINGS_PATH`
can select its directory. The complex-setting bridge continues to support
arbitrary settings filenames.

Other advertised commands are forwarded unchanged, including enabled skill
commands. Once native discovery arrives, an unadvertised slash command is
rejected with an explanation instead of being silently sent to the model.
Terminal commands such as `/resume`, `/tasks`, and `/theme` are not
synthesized. Use the client's session picker (`session/list` and
`session/load`) to resume sessions. For an AI-credit limit, use native
`/autopilot ... --max-ai-credits N` or the startup flag.

The proxy forwards the client's original initialize parameters, including
filesystem/terminal capabilities and extension metadata. The same negotiation
is reused after a credential restart. Native session loading and history replay
stay owned by Copilot; the adapter adopts the loaded session's cwd and metadata
for its helper commands and reporting. Both `session/close` and the compatibility
alias `closeSession` close the native session.

Before native command discovery arrives, unknown slash commands are forwarded.
`/agents` is not synthesized as an ACP command.

`session/new`'s `cwd` parameter is treated as the client-provided working
directory. In Emacs agent-shell, this is controlled by
`agent-shell-cwd-function`; when the client does not send a cwd, the adapter
uses its startup directory.

`/subagents` is implemented locally by the adapter because Copilot exposes it
only as an interactive UI command. The adapter discovers project-defined agents
from `.github/agents` under the session cwd first. If none are found there, it falls
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

`/skills` is a native Copilot command and is proxied unchanged; skill commands
in the menu are exactly the ones Copilot advertises.

### Project skill smoke tests

This repository includes three project-local GitHub Copilot skills under
`.github/skills/`:

- `/adapter-smoke-test [text]`: no-tool deterministic invocation test. Expected
  output begins with `COPILOT_SKILL_SMOKE_TEST=PASS` and echoes the arguments.
- `/adapter-resource-test`: asks Copilot to read a resource bundled beside its
  `SKILL.md`. Expected output is
  `COPILOT_SKILL_RESOURCE_TEST=PASS:RESOURCE_LOADED`.
- `/adapter-project-summary [focus]`: performs read-only inspection of key
  adapter files and returns a structured architecture summary. Its description
  also allows Copilot to select it automatically for matching plain-language
  requests.

From the repository root, first verify what the installed CLI discovers:

```sh
copilot skill list --json
```

Then start a fresh agent-shell session whose cwd is this repository and try:

```text
/skills
/adapter-smoke-test hello from emacs
/adapter-resource-test
/adapter-project-summary skill discovery
```

To test automatic skill selection rather than explicit slash invocation, ask:

```text
Give me an adapter architecture summary and recommend the best next agent-shell test.
```

Completion updates whenever Copilot advertises a new command snapshot.
Authentication is required for skill execution.

### Project agent smoke tests

This repository includes three deliberately distinct project agents under
`.github/agents/`:

- `adapter-explorer`: read-only architecture and request-flow exploration.
- `test-diagnostician`: test execution and failure diagnosis without edits.
- `adapter-reviewer`: diff review for ACP compatibility and regressions.

Select a custom agent through Copilot's `agent` configuration option. Clients
without a general configuration picker can send `session/set_config_option`
with the exact native option ID/value, or start Copilot with
`--agent adapter-explorer` in `COPILOT_ACP_ARGS`. Each fixture's final response
starts with a unique `TEST_AGENT=...` marker so a model request can confirm
selection.

## Subagent dispatch reporting

The adapter records the **requested model** from a delegation `tool_call`'s
`rawInput`. At the end of that prompt, the adapter makes a bounded (256 KiB tail) best-effort read of the
specific configured `COPILOT_SESSION_STATE_PATH/<session-id>/events.jsonl` file. For only
the tool-call IDs observed in that current adapter session, it reports the
correlated `subagent.completed` event's `firstDispatchedModel`, plus structured
thought `_meta` fields: `requestedModel`, `firstDispatchedModel`,
`explicitModelOverride`, `toolCallId`, and `mismatch`.

`firstDispatchedModel` is the CLI's recorded first dispatched model, not a list
of every model used by a subagent and not independently verified serving-model
telemetry. A requested/recorded mismatch may be Copilot aliasing or routing and
does not by itself indicate an adapter bug. The adapter never treats
`rawInput.model`, `subagent.configured`, or assistant-message `data.model` as
dispatch proof. Missing, unreadable, malformed, delayed, or out-of-tail journal
evidence is reported as `unknown`; it does not fail or alter the original ACP
prompt, messages, routing, or permissions. Reads happen only after a completed
prompt response (with two short retries), never per streaming token; there are
no watchers. A report is emitted once per observed tool call, so late evidence
will not create a contradictory history entry.

### Verbal model-request reporting

A natural-language prompt mentioning a model ID, such as:

```text
can you run the tests with gpt-5.6-luna with the test runner skill
```

now receives a visible `Model report` after the response, even when no subagent
is delegated. IDs from the native model catalog are also recognized with spaces
in place of hyphens (for example, `GPT 5.6 Luna`). The report distinguishes:

- the model mentioned in the prompt;
- the session agent/model selected in Copilot;
- session model calls recorded by `model.call_start` or `assistant.usage`;
- structured skill invocations and delegation requests;
- a delegated agent and its first dispatched model recorded by a correlated
  `subagent.completed` event.

If dispatch evidence is unavailable, the output explicitly identifies the
session model or subagent override **requested from Copilot**, without claiming
it was used. A skill's name is not treated as a model or an agent. The adapter
observes execution and does not rewrite the prompt or change model selection.

The adapter reads only a bounded 256 KiB journal tail appended after that
prompt began. Historical events, assistant prose, configuration, and
`assistant.message.model` are not dispatch evidence. Runtime events such as
`assistant.usage` are ephemeral and may be absent from the native journal, so
session-model reporting can fall back to the requested model. Model
call events describe Copilot's runtime routing/usage, not independently verified
provider serving-model telemetry.

Concurrent prompts in one session prevent reliable attribution and are labeled
as such; closing/restarting a session clears report tracking. Reports are emitted
once per model-mentioning prompt, including failed/cancelled requests, and never
establish that the requested tests or task actually completed.

### Opt-in live verification

The normal offline suite never launches Copilot. The live assertion is skipped
unless explicitly enabled:

```sh
COPILOT_LIVE_TEST=1 npm run test:live

# Optionally run the same fixture/scenario directly against native Copilot too.
COPILOT_LIVE_TEST=1 COPILOT_LIVE_COMPARE_NATIVE=1 npm run test:live
```

It requires an already authenticated CLI and sends a real request, which can
consume quota. It creates and removes an isolated temporary fixture containing
a tiny `npm test` and a no-edit `test-diagnostician` agent. It does **not** use
`--allow-all`, log in, change settings, print transcripts or credentials, or
grant broad permission requests; an unexpected approval request fails clearly.
The primary path launches `bin/copilot-acp-adapter.js` with Node, creates the
session with `{cwd,mcpServers:[]}`,
and explicitly calls `session/set_model` for the parent model. With
`COPILOT_LIVE_COMPARE_NATIVE=1`, the direct native path uses the same scenario
and strict verifier through FIFO transport (not nested piped stdio). Each path
prints concise JSON with its mode, session ID, requested parent/subagent,
recorded first dispatch and override, including mismatches; both paths run even
if the first fails. A native-only result is still useful diagnostic reporting.
The strict verifier requires an observed delegated tool call and a correlated
`subagent.completed` record with exact agent/requested/first-dispatched/
explicit-override model strings, rather than assistant prose. Consequently an
unknown or missing journal record is a strict live-test failure, while normal
adapter runtime reporting remains best-effort and labels such evidence
`unknown`. It reads only the generated session ID from the configured real
session-state directory; it does not override `COPILOT_HOME` or alter user
settings.
Configure the parent and delegated expected model IDs (defaults are Terra and
Luna) and timeout with:

```sh
COPILOT_LIVE_PARENT_MODEL=gpt-5.6-terra \
COPILOT_LIVE_SUBAGENT_MODEL=gpt-5.6-luna \
COPILOT_LIVE_TIMEOUT_MS=120000 \
COPILOT_LIVE_TEST=1 npm run test:live
```

CLI versions, account policy, aliases, routing, permissions, or delayed journal
writes can make this intentionally strict integration test fail. The child
forces `COPILOT_LIVE_TEST=0` so a delegated `npm test` cannot recursively start
another live request. The test closes native transport and removes its fixture
on success or failure.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Verification against Copilot 1.0.104

Offline `npm test` includes a subprocess integration check with a fake native
ACP peer that mirrors the 1.0.104 session metadata: client capability
negotiation (including credential restart), native command snapshots,
configuration metadata, permission round trips, token usage, session
loading/history, `/changelog summarize`, and both close paths. It never
launches Copilot.

`node scripts/probe-native-acp.mjs` records the real CLI's advertised commands
and session metadata without a model request. Model prompts and subagent
dispatch remain covered by the separate opt-in `test:live` suite. The native
raw-event additions in 1.0.81 are not assumed to expose `firstDispatchedModel`;
the bounded journal reader remains until that specific evidence is verified on
the wire.
