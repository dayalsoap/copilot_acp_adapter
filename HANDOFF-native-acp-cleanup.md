# Handoff: remove adapter features that native `copilot --acp` now covers

Written 2026-10-27, against HEAD `a0528e7`. Read this file, `AGENTS.md`, and `REVIEW.md`
before starting.

## Goal

Copilot's own ACP server (`copilot --acp`) now covers much of what this adapter built by
hand. Shrink the adapter until it only:

1. proxies to native `copilot --acp`, and
2. covers the gaps native ACP still has (mainly auth and commands that are interactive-only
   in the CLI).

Every removal must be backed by evidence from the installed CLI: the probe output
(Phase 0) or an observed native response. Changelog lines alone are not evidence.
Where the evidence is ambiguous, keep the code and record why in the final report.

## Ground rules

- Work on a new branch: `git checkout -b native-acp-cleanup`. Do not push.
- One commit per phase, and `npm test` must pass before each commit. When you delete a
  feature, delete or rewrite its tests too. Don't leave skipped tests behind.
- Do not change the transport/framing fixes from REVIEW.md (`json-rpc.js` byte-buffer
  framing, parse-error resync, blank-line handling, `rejectAll`, the restart guards,
  `scheduleAvailableCommands` ordering).
- `.agent-shell/` contains transcripts that may hold secrets. Don't read them, and don't
  commit them.
- Stop and ask before deleting anything not listed here.

## Background: what native ACP does and doesn't do

From GitHub's ACP reference and the CLI changelog up to 1.0.104:

- **Native has:**
  - session `new`/`load` (0.0.410), `list`, and `closeSession` (1.0.78)
  - model, mode (agent/plan/autopilot), custom agent, `allow_all`, and reasoning effort,
    all via `configOptions`, with live updates for config, mode, title, commands and plan
    (1.0.81)
  - `/compact` `/context` `/usage` `/env` (1.0.39)
  - skills as `/skill-name` (1.0.40)
  - `/model` `/mcp` `/plan` `/review` `/research` `/session` `/rename`
  - `usage_update` and token usage in prompt results (1.0.78)
  - subagent IDs and raw event subscriptions (1.0.81)
  - custom agents via ACP task calls (1.0.92)
  - sandbox settings in ACP (1.0.103)
  - MCP servers on `session/new` and `session/load`
- **Interactive-only (NOT available over ACP):** `/diff` `/resume` `/theme` `/settings`
  `/login` `/help` `/tasks` `/undo`.
- **Unadvertised commands:** native forwards any slash command it doesn't advertise to the
  model as an ordinary prompt. That's why the adapter rejects them, and that behavior
  stays.
- **Command updates:** `available_commands_update` is a full replacement every time.

## Phase 0: capture native ground truth (no code changes)

1. Run `copilot --version`. If it's older than 1.0.104, run `copilot update` and say so in
   the report.
2. Run `node scripts/probe-native-acp.mjs`. It starts `copilot --acp --stdio`, sends
   `initialize`, `session/new`, and `session/list`, then closes the session. It sends no
   prompts and uses no model calls. Output goes to `scripts/native-acp-probe.json`.
3. Record from the JSON:
   - `commandNames`: the full list of commands native advertises
   - `initialize.agentCapabilities` and `initialize.authMethods`
   - whether `sessionNew` has `models` / `modes` or only `configOptions`, plus the
     `configOptions` ids and categories
   - `order`: does `update:available_commands_update` arrive before or after `response#2`?
   - `sessionList`: does it work, and do the titles contain newlines?
4. Commit `scripts/probe-native-acp.mjs` (it's a useful regression tool). Add
   `scripts/native-acp-probe.json` to `.gitignore`.

Use these results to decide every "if" below.

## Phase 1: let native win name collisions (small behavior fix)

Bug: `shouldHandlePromptLocally` (src/adapter.js ~L137) checks `NATIVE_HELPER_COMMANDS`
*before* it checks the native command list. So a local helper silently shadows a native
command with the same name.

`mergeAvailableCommands` lists native first, so the menu shows native's description while
the adapter's local code runs.

- **Change:** in native mode, a helper is handled locally only when native has *not*
  advertised that command for the session (`this.nativeCommands.get(sessionId)`). If
  native's list hasn't arrived yet, keep the current behavior.
- **Tests:** add one test per direction. A native-advertised `/changelog` is proxied; a
  helper that native doesn't advertise is still handled locally.

## Phase 2: remove helpers native now covers

Look up each command in Phase 0's `commandNames`.

| Helper | Native advertises it | Native doesn't advertise it |
|---|---|---|
| `/changelog` | Delete it, plus `src/changelog.js`, `test/changelog.test.js`, `COPILOT_CHANGELOG_*` config, and `fetchImpl` plumbing that nothing else uses | Keep |
| `/version`, `/update` | Delete them from `NATIVE_HELPER_COMMANDS` and `DIRECT_COPILOT_COMMANDS` | Keep |
| `/subagents` | Delete it, but keep the `/settings` subagent JSON bridge | Keep |
| `/experimental`, `/keep-alive` | Delete them | Keep |
| `/theme` | Delete it either way: it's a terminal color setting with no meaning in Emacs | — |
| `/help`, `/diff`, `/settings`, `/login`, `/logout`, `/exit` | Should not appear. If one does, report it and leave it alone | Keep |

Also in this phase:

- In `initialize()`, delete the stale `_meta.nativeCommands`, `_meta.copilotCommands`,
  `_meta.copilotTransports`, and `_meta.directCopilotCommands`.
- In `enhanceInitialize`, keep `backend` and `commandDiscovery`.

## Phase 3: remove the `prompt` backend (biggest cut)

`COPILOT_BACKEND=prompt` (the `copilot -p` per-prompt path) duplicates what native now
provides. Remove it and make native-acp the only backend.

> **The user may veto this phase.** If the user has said to keep the prompt backend, skip
> Phase 3 and do only the native-mode-only cleanups in Phase 4.

Remove:

- `config.copilotBackend` and every branch on it (10 in `adapter.js`, 1 in `server.js`).
  Also remove the `COPILOT_BACKEND`, `COPILOT_ARGS`, and `COPILOT_TRANSPORT` env vars, and
  any other config used only by the prompt path.
- **Prompt-path handlers in `adapter.js`:**
  - `newSession`, `sessionStartResult`, `listSessions`, `loadSession`
    (native-mode equivalents: `adoptNativeSession` / proxy)
  - the non-slash half of `prompt()`: `runner.runPrompt`, the JSON event forwarder,
    `buildPromptArgs`, `buildProjectSkillPrompt`, `findProjectSkill`
  - the whole `handleNativeCommand` switch for `/model` `/agent` `/autopilot` `/cwd`
    `/add-dir` `/list-dirs` `/allow-all` `/reset-allowed-tools` `/resume` `/rename`
    `/session` `/context` `/usage` `/memory` `/limits` `/new` `/clear`
  - the prompt-only `/exit` branch
  - the prompt-backend list in `shouldHandlePromptLocally`
  - `setModel` / `setConfigOption` / `setMode` local implementations, if only the prompt
    path reaches them (check `shouldHandleLocally`; they proxy in native mode)
  - `sessionModes`, `sessionConfigOptions`, `applySession*`, `resolveSessionModelId`,
    `handleUsageCommand`, `handleLimitsCommand`, and similar helpers, once they have no
    callers
- **Whole modules:**
  - `src/copilot-json-events.js`
  - `src/session-store.js`, except `normalizeSessionListResult` / `normalizeSessionTitle`.
    Move those two into `server.js` or a small `session-title.js`.
  - `src/models.js`, if the `sessionModels()` fallback is gone (Phase 4) and `config.js`
    no longer needs `parseModelCatalog`
  - `src/project-agents.js`: only if its discovery is used solely for the prompt path.
    Native now advertises skills itself. Check the `agent` config option in the probe
    first.
- **`copilot-runner.js`:** delete `runPrompt` and `withJsonEventArgs`. Keep `runCommand`
  / `runProcess`, which `/login`, `copilot config`, and the direct commands use. Keep the
  PTY helpers only if login still uses them.
- **Tests:**
  - delete tests for removed code
  - change any test that sets `copilotBackend: "prompt"` to target native, or delete it if
    native now owns that behavior
  - `test/server-integration.test.js` (fake-peer native test) must keep passing and is the
    main safety net

Afterwards, `grep -rn "prompt backend\|copilotBackend\|runPrompt" src test` should return
nothing.

## Phase 4: native-mode shims to check against the probe

| Shim | Where | Remove if… |
|---|---|---|
| `sessionModels()` fallback (spawns model discovery) | `enhanceSessionStartResult` | `sessionNew` contains `models` or a model `configOption`. It should, so delete the fallback. |
| `models`/`modes` synthesized from `configOptions` | `enhanceSessionStartResult`, `modelsFromConfigOptions`, `modesFromConfigOptions` | Native sends `models` and `modes` itself. Otherwise **keep**: agent-shell's header reads those fields (AGENTS.md). |
| `/autopilot` prompt → `session/set_mode` rewrite | `server.js` `nativeAutopilotModeMessage` | `autopilot` is in `commandNames`. The code already disables itself in that case, so delete it. |
| `set_config_option(mode)` → `set_mode` rewrite | `server.js` `nativeConfigModeMessage`, `nativeModeIdFromConfigOption` | A live test passes: send `session/set_config_option` for the mode option directly to native and check that the mode changes (a `current_mode_update` / `config_option_update` arrives). Use a scratch script like the probe. No prompt is needed. |
| Journal-based subagent/model evidence | `subagent-reports.js`, `model-reports.js` journal reads, `reportNativeSubagentDispatch`, `nativeSubagentStarts` | Native `tool_call` updates for subagent tasks (1.0.81 subagent IDs / raw events) carry the model actually dispatched. **This needs a real prompt and uses model credit.** Run `COPILOT_LIVE_TEST=1 node --test test/live-subagent.test.js` once, inspect the raw updates, and decide. Default: keep it and report what you found. |
| `activity-status.js` synthesized status lines | `enhanceNativeMessages` | Only if native's live title/plan updates make them duplicates in agent-shell. Ask the user rather than deciding alone. |

## Keep (don't touch beyond the refactors above)

- **Auth:**
  - `/login`, plus ACP `authenticate` for `github.com` / `github-enterprise` / `api-key`
  - `/logout`
  - `applyAuthChange` → `NativeAcpBackend.restart`
  - `auth.js`

  Native `/login` is interactive-only, and native auth expects client terminal-auth.
- **Commands native doesn't run over ACP:** `/help` (lists native and helper commands),
  `/diff`, and `/settings` with its `copilot config` bridge and the subagent JSON bridge
  (`settings.js`).
- **Session plumbing:**
  - mapping `/exit` to native `session/close`
  - rejecting unadvertised slash commands
  - merging local and native lists into `availableCommands`
  - `scheduleAvailableCommands` ordering
- **Transport:**
  - FIFO transport for the nested native process (stdio exits when the adapter's own
    stdin is piped)
  - auto-detecting Content-Length vs NDJSON framing
  - session-title whitespace normalization on `session/list` (commit a0528e7; the 1.0.103
    title fix was TUI-only)

## Finish

1. Update `README.md` and `AGENTS.md`:
   - remove the backend-selection docs and the deleted env vars and commands
   - add a short "what the adapter adds over native" list
   - note the probe script
2. Run `npm test`, then run a smoke test by hand:
   ```sh
   printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
     | node ./bin/copilot-acp-adapter.js
   ```
3. Write `CLEANUP-REPORT.md` covering:
   - CLI version and probe highlights
   - what you removed and the evidence for each removal
   - what you kept and why
   - line counts before and after (`wc -l src/*.js`)
   - anything left for the user to check in Emacs agent-shell: the header model/mode, the
     command menu, `/login api-key`, and session picker titles
4. Leave the branch unmerged so the user can review it.
