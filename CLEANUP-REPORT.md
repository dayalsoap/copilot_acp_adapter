# Native ACP cleanup report

Branch `native-acp-cleanup`, based on `a0528e7`, done 2026-10-27. The branch is not
merged and not pushed. One commit per phase, and `npm test` passed before each one.

## CLI version and probe highlights

- Copilot CLI was **1.0.93**. I ran `copilot update` and it is now **1.0.104**.
- `node scripts/probe-native-acp.mjs` (committed in Phase 0; its JSON output is ignored)
  found:
  - **`commandNames` (35):** `/add-dir /after /allow-all /autopilot /blame /chronicle
    /compact /context /cwd /env /every /fleet /init /list-dirs /mcp /memory /model
    /permissions /plan /plugin /remote /rename /research /reset-allowed-tools /review
    /sandbox /security-review /session /share /skills /subconscious /usage`, plus the
    three project skills (`/adapter-project-summary /adapter-resource-test
    /adapter-smoke-test`).
  - **Not advertised:** `/changelog /version /update /subagents /experimental
    /keep-alive /help /diff /settings /login /logout /exit /theme /resume /tasks`.
  - **`initialize.agentCapabilities`:** `auth.logout`, `loadSession`, `mcpCapabilities`
    (http, sse), `promptCapabilities` (image, embeddedContext), and
    `sessionCapabilities` `close` + `list`.
  - **`initialize.authMethods`:** only `copilot-login`, through `terminal-auth`. Its
    command is `/opt/homebrew/Caskroom/copilot-cli/1.0.69/copilot`, which is a **stale
    path** (see "Check in Emacs").
  - **`sessionNew`:** returns `models`, `modes` **and** `configOptions`. The
    `configOptions` are `mode`/`mode`, `model`/`model`, `agent`/`_agent` and
    `allow_all`/`permissions` (id/category). Mode ids are full URLs such as
    `https://agentclientprotocol.com/protocol/session-modes#plan`.
  - **`order`:** `available_commands_update` arrives **before** `response#2` (the
    `session/new` result). `scheduleAvailableCommands`, which re-sends the update after
    the result, is still needed.
  - **`sessionList`:** works and returned 18 sessions. **3 of the titles contain
    newlines**, so the title normalization from `a0528e7` is still needed.
- **Re-verified on an entitled account with 1.0.105.** Copilot auto-updated itself to
  1.0.105 later the same day. My first probes ran on a free plan, which offers only
  `auto`. After the account was upgraded, the probe listed `auto`, `claude-haiku-4.5`,
  `gpt-6-luna`, `gpt-5.6-luna` and `mai-code-1.1-flash`, with `claude-haiku-4.5` as the
  current model. It also showed:
  - the same 35 commands, with none added or removed and no adapter helper advertised;
  - `session/new` still returns `models`, `modes` and `configOptions`;
  - `available_commands_update` still arrives before the `session/new` result;
  - 3 of 18 session titles still contain newlines.

  Every Phase 2–4 decision still holds.
- **Live `session/set_config_option` check** (scratch script, no prompt): I set
  `configId: "mode"` to the `#plan` URL. Native answered with `current_mode_update`, then
  `config_option_update`, then a response whose mode `currentValue` was `#plan`.

## What was removed, and the evidence

| Phase | Removed | Evidence |
|---|---|---|
| 1 | The helper no longer shadows a native command with the same name. The menu now lists native commands first, so the description matches the code that runs. | Behavior fix from the handoff, with tests for both directions. |
| 2 | `/theme` helper | It is a terminal color setting, so it is removed either way. |
| 2 | `initialize` `_meta.nativeCommands`, `copilotCommands`, `copilotTransports`, `directCopilotCommands` | Stale lists that were kept by hand. `enhanceInitialize` still sets `backend` and `commandDiscovery`. |
| 3 | `COPILOT_BACKEND=prompt` and everything that only it used: the `COPILOT_BACKEND`, `COPILOT_ARGS`, `COPILOT_TRANSPORT` and `COPILOT_FORCE_TTY_DIRECT_COMMANDS` variables; local `newSession`, `sessionStartResult`, `listSessions` and `loadSession`; the `runner.runPrompt` path, JSON event forwarder, `buildPromptArgs` and project-skill prompt injection; the whole local `/model /agent /autopilot /cwd /add-dir /list-dirs /allow-all /reset-allowed-tools /resume /rename /session /context /usage /memory /limits /new /clear` switch; the prompt-only `/exit`; and `setModel`, `setConfigOption` and `setMode` (`shouldHandleLocally` never routed these locally) | The handoff's Phase 3. Native owns these, and the fake-peer integration test still passes. |
| 3 | `src/copilot-json-events.js`, `src/session-store.js` | The title helpers moved to `src/session-title.js`. |
| 3 | `runPrompt`, `withJsonEventArgs`, and the PTY helpers (`buildPtyCommand`, `detectScriptStyle`, `isPtyWrapperFailure`) | Login never used the PTY. Only the direct commands could, and the two that remain (`/version`, `/update`) don't need a TTY. |
| 3 | Direct `/init /skills /mcp /plugin` routing and the local `/skills` listing | All four are in `commandNames`. |
| 3 | `discoverProjectSkills` (in `project-agents.js`) | It had no callers left. `discoverProjectAgents` stays because `/subagents` uses it. |
| 4 | The `sessionModels()` discovery fallback, `src/models.js`, and the `COPILOT_MODEL`, `COPILOT_MODEL_NAME`, `COPILOT_MODELS`, `COPILOT_MODE` and `COPILOT_MODEL_DISCOVERY_TIMEOUT_MS` variables | `sessionNew` contains `models` and a `model` config option. In native mode these variables never reached Copilot; they only labeled fallback metadata. To set a startup model, put `--model` in `COPILOT_ACP_ARGS`. |
| 4 | `models`/`modes` synthesized from `configOptions` | Native sends `models` and `modes` itself. |
| 4 | The `/autopilot` → `session/set_mode` rewrite | `/autopilot` is in `commandNames`. |
| 4 | The `set_config_option(mode)` → `set_mode` rewrite, along with session mode-id tracking | Shown by the live `set_config_option` check above. |
| Follow-up | `src/activity-status.js` and the "Enabling `X` skill." / "Delegating to `Y` subagent." thought lines it produced | Your decision: use Copilot's own tool-call, title and plan updates. Native `tool_call`s now pass through untouched. The adapter still records each delegation's requested model for the dispatch report. |

One feature moved instead of being deleted. **`/changelog summarize` used to call
`copilot -p`.** It is now rewritten in `server.js` into an ordinary native prompt that
carries the selected release notes. A fetch failure is answered locally, exactly once.
Unit and integration tests cover both cases. The model-mention report is computed from
the user's own text, so model names in the release notes don't trigger it.

## What was kept, and why

- **All of auth:** `/login`, ACP `authenticate` (github.com, github-enterprise,
  api-key), `/logout`, `applyAuthChange` → `restart`, and `auth.js`. Native only offers
  terminal-auth `copilot-login`.
- **Helpers native doesn't advertise:** `/help /diff /settings /subagents /changelog
  /experimental /keep-alive /version /update`, plus `/exit` with arguments. None of them
  are in `commandNames`.
- **Session plumbing:** bare `/exit` → `session/close`, rejection of unadvertised
  commands, the merged command list, and `scheduleAvailableCommands` (the probe `order`
  shows it is still needed).
- **Transport:** the FIFO transport, framing auto-detect, and title normalization (3
  multi-line titles in the probe). None of the REVIEW.md transport fixes were touched.
- **Journal-based subagent/model evidence** (`subagent-reports.js`, `model-reports.js`,
  `reportNativeSubagentDispatch`, `nativeSubagentStarts`). The live run gave no reason to
  remove it. Your run on 1.0.105 with parent `gpt-6-luna` and subagent `gpt-5.6-luna`
  (session `6121e30d…`) did delegate. The ACP `tool_call` carried the requested model
  (`rawInput.model = gpt-5.6-luna`), but nothing on the wire that the adapter saw carried
  the dispatched model. That still comes only from the journal: `subagent.started` and
  `subagent.configured` there name `gpt-5.6-luna`, with
  `modelSelectionSource: explicit_override`. The test still failed, for two reasons
  unrelated to the cleanup:
  - **The harness cancels every permission request.** The subagent's `npm test` shell call
    needed one, was denied (`denied-interactively-by-user`), and the subagent ended with
    `subagent.failed` ("Agent completed but produced no response") instead of
    `subagent.completed`.
  - **The reporter only reads `subagent.completed`.** `subagent.failed` carries the same
    `firstDispatchedModel` (`gpt-5.6-luna`) and `explicitModelOverride` fields, but
    `subagent-reports.js` and `model-reports.js` ignore it, so the report said
    `firstDispatchedModel: unknown`, `evidence: unavailable`. This gap predated the
    cleanup. It is now fixed (see "Follow-ups done after the cleanup").
- **`project-agents.js`:** its agent discovery is used by `/subagents`.

## Follow-ups done after the cleanup

- **`subagent.failed` counts as dispatch evidence.** The subagent dispatch report and
  the model report now read `subagent.failed` as well as `subagent.completed`. A failed
  subagent's report says "(subagent failed)" and `_meta.evidence` is `subagent.failed`.
  It still shows the recorded first dispatched model. The strict live verifier still
  requires `subagent.completed` and names `subagent.failed` when it sees one.
- **The live test allows exactly the fixture's `npm test`, once.** It picks `allow_once`
  only when the permission request's `rawInput.command` is exactly `npm test`, and
  cancels everything else, including `allow_always`-only offers and `npm test` with extra
  arguments. A failure now lists the denied request titles. The match on
  `rawInput.command` comes from the journal: there, the subagent's tool arguments were
  `{command: "npm test", ...}`. It has not yet been seen in an ACP permission request; the
  next live run will show whether it matches.

## Line counts (`wc -l src/*.js`)

| File | Before | After |
|---|---:|---:|
| activity-status.js | 29 | — |
| adapter.js | 2352 | 1170 |
| auth.js | 188 | 188 |
| changelog.js | 54 | 54 |
| commands.js | 174 | 174 |
| config.js | 105 | 79 |
| copilot-json-events.js | 341 | — |
| copilot-runner.js | 343 | 189 |
| json-rpc.js | 143 | 143 |
| model-reports.js | 154 | 154 |
| models.js | 338 | — |
| native-acp-backend.js | 351 | 351 |
| project-agents.js | 216 | 203 |
| server.js | 373 | 320 |
| session-store.js | 199 | — |
| session-title.js | — | 15 |
| settings.js | 96 | 96 |
| subagent-reports.js | 100 | 104 |
| **total** | **5556** | **3240** |

Tests went from 115 to 84 (83 pass, plus the opt-in live test, which is skipped). Tests
for deleted code were deleted. Tests that used `session/new` or `copilotBackend` now use
adopted native sessions.

## Left for you to check in Emacs agent-shell

1. **Header model and mode.** These now come from native `models`/`modes` unchanged.
   The upgraded account should show the full model list (the free plan showed only
   `Auto`, twice). Check that the mode switches.
2. **Command menu.** It should show native commands, the helpers, and no `/theme`.
   `/help` should list the same set. Try `/changelog summarize last 2`.
3. **`/login api-key <token>`.** The backend should restart, and a follow-up prompt
   should authenticate.
4. **Session picker titles.** They should be single-line. Three of your current titles
   contain newlines natively.
5. **Native `copilot-login` auth method.** Its terminal-auth command points at
   `/opt/homebrew/Caskroom/copilot-cli/1.0.69/copilot`, an old path that may not exist.
   This is a native-side issue, not something the adapter changes, but agent-shell would
   hit it if it offers terminal auth.

## Open questions and possible follow-ups

- **Dead config fields, left alone:** `ghCommand` and `copilotHome` in `config.js` were
  unused before this cleanup and weren't on the removal list.
- **`commands.js`:** after the cleanup, the full catalog (`listCommands`, `COMMAND_SET`,
  the `supported` flag, and the project-skill parameter of `listAvailableCommands`) is
  only used by its own tests and for helper descriptions. It could shrink to the helper
  descriptions, but it isn't on the removal list and AGENTS.md calls it the canonical
  catalog.
