# copilot_acp_adapter — code review

Reviewed and fixed 2026-08-22. Every finding below was reproduced against the source
before the fix and re-run after it. Test suite went 75 → 87 (12 new regression tests);
all pass.

Scope was the wire path and session lifecycle: `json-rpc.js`, `server.js`,
`native-acp-backend.js`, `adapter.js`, `commands.js`, `copilot-runner.js`.

The command-table design is sound and was left alone. The text-vs-state split is in good
shape — `shouldHandlePromptLocally` keeps two explicit lists per backend, `/model` and
`/agent` correctly proxy to native rather than being faked locally, and
`availableCommands` synthesis merges native-first with local fallback. Every bug was in
the transport and session plumbing underneath it.

---

## 1. Content-Length framing corrupted any message containing non-ASCII — FIXED

**`src/json-rpc.js`** — `Content-Length` is a **byte** count, but the buffer was a JS
string (`setEncoding("utf8")` on input) sliced by **character** index.

```js
const bodyEnd = bodyStart + contentLength;   // byte count used as char offset
return JSON.parse(this.buffer.slice(bodyStart, bodyEnd));
```

A prompt containing `café — naïve 🚀` is 119 bytes and 113 characters, so the body was
truncated by 6 bytes and `JSON.parse` threw. This fired on em-dashes, curly quotes,
accented names, box-drawing characters in diffs, emoji — routine model output. Only
affected clients using `Content-Length` framing, so `agent-shell` (newline) dodged it.

**Fix:** the buffer is now a `Buffer`, not a string; `setEncoding` is gone and framing
slices by byte offset, decoding to UTF-8 only once a complete frame is in hand. This also
makes a body split mid-character across two chunks work, which is now covered by a test.

## 2. One malformed line killed the adapter process — FIXED

**`src/json-rpc.js`** — `JSON.parse` and the invalid-header `throw` both ran inside the
`input.on("data")` handler, outside any `try`/`catch`. `server.js` wrapped
`handleMessage`, but the parse happened before `emit("message")`.

```
$ printf '{oops}\n{"jsonrpc":"2.0","id":1,"method":"initialize"}\n' | node ./bin/copilot-acp-adapter.js
SyntaxError: Expected property name or '}' in JSON at position 1
```

Process exited; the valid `initialize` behind it was never answered. From Emacs this looked
like the agent silently dying. This was also the blast radius of #1 — one accented
character didn't fail a message, it took down the adapter.

**Fix:** parse failures are caught, logged to stderr, and re-emitted as a `parseError`
event; `server.js` answers with JSON-RPC `-32700`. Framing resynchronises on the next
frame boundary. Same input now yields the error response *and* the `initialize` result.

## 3. A blank line stalled every message queued behind it — FIXED

**`src/json-rpc.js`** — the empty-line guard returned `null`, which the caller treated as
"incomplete frame" and stopped the drain loop:

```js
if (!line) {
  return null;      // caller's `while` did `return`, not `continue`
}
```

`"\n" + msgA + "\n" + msgB + "\n"` in one chunk yielded **zero** messages, and they stayed
buffered until another chunk arrived — which never happens if the client is waiting for a
reply to `msgA`. Deadlock, not delay.

**Fix:** `readNextFrame` now distinguishes "incomplete" from "skip this frame"; blank lines
are consumed and draining continues.

## 4. `ensureSession()` returned a Promise's `.sessionId` — i.e. `undefined` — FIXED

**`src/adapter.js`** — `newSession` is `async`, so `.sessionId` on its return value was
always `undefined`:

```js
return this.newSession({ ... }).sessionId;   // Promise.sessionId === undefined
```

`prompt()` then ran the whole turn with `session === undefined`, two ways:

- Commands dereferencing `session` directly threw — `/session` gave
  `TypeError: Cannot read properties of undefined (reading 'id')`, surfaced as `-32603`.
- Commands using `session?.id` **silently succeeded with no output**, because `sendText`
  early-returned on a falsy sessionId:

```
turn result:            "end_turn"
content chunks emitted: 0     <-- /help text went nowhere
second identical turn -> content chunks emitted: 1
```

The retry worked because `newSession`'s body runs synchronously up to
`this.sessions.set(...)`, so the *side effect* landed even though the return value was
lost — the "it worked when I retried" signature. Triggered whenever the client prompted
with a sessionId the adapter didn't hold: after `/exit`, after an adapter restart against
a resumed session, or from a client that skips `session/new`.

**Fix:** `ensureSession` is now `async` and awaited. `sendText` logs to stderr instead of
dropping output silently, so this cannot hide again.

One subtlety worth knowing: adding the `await` moved `startOperation` past a microtask,
which reopened a narrow race where a `session/cancel` arriving in the same chunk as its
`session/prompt` could find no operation registered and cancel nothing. `prompt()` now
resolves a session it already holds synchronously (`knownSessionId(params) ?? await …`),
so the common path reaches `startOperation` with no await in between.

## 5. A backend crash left in-flight client requests unanswered — FIXED

**`src/native-acp-backend.js`** — `rejectAll()` only drained `pendingBackendRequests`
(adapter-originated). `forwardedClientRequests` and `forwardedClientResponses` — the
client's own in-flight requests — were left in the map. The `close` handler built a
perfectly good error (`Native Copilot ACP exited with code 1`) and used it only for the
wrong map. Emacs hung on that turn with no error and no recovery short of restarting the
agent; both maps also grew unbounded over a long session.

**Fix:** `rejectAll` now sends a `-32000` error response for every forwarded client
request (applying `transformResponse` where one was registered) and clears both maps.
The child's `close`/`error` handlers are also guarded against a superseding restart, so a
relaunch cannot null out its replacement's handle.

## 6. `/login api-key` was a no-op against the default backend — FIXED (restart)

`adapter.js` stored the token in `session.env`; `server.js`'s `refreshNativeEnv` read
`adapter.globalEnv` — a different bag — **and** bailed whenever `nativeBackend.child` was
set. The child is spawned during `main()` by the startup `initialize`, so it was always
set: `refreshNativeEnv` was dead code. The user was told "API key loaded into this adapter
process" and the next prompt still failed auth.

**Fix:** environment cannot be injected into a running process, so credential changes now
relaunch it. `NativeAcpBackend.restart(env)` kills the child, waits for its `close` (2s
cap), and merges the new env; `server.js` re-runs the ACP handshake and replaces the
stored initialize promise. `/login api-key`, `/logout`, and the ACP `authenticate` method
all route through `adapter.applyAuthChange()`. Verified end to end — the relaunched
process carries the token:

```
copilot processes spawned: 2
  token per spawn: ["(none)", "ghp_NEWTOKEN"]
```

A failed restart now reports `stopReason: "error"` rather than claiming success. Because
Copilot-side sessions do not survive the relaunch, the user-facing message says so and
tells them to run `/new`. `refreshNativeEnv` was deleted.

## 7. `available_commands_update` was emitted before the `session/new` result — FIXED

Surfaced while smoke-testing the fixes rather than in the original read. `sendAvailableCommands`
fired inside `newSession` *before* the response was written:

```
{"jsonrpc":"2.0","method":"session/update",...available_commands_update...}
{"jsonrpc":"2.0","id":2,"result":{"sessionId":...}}
```

A client that receives a session update for a session it has not registered yet will
discard it — a plausible cause of the command menu intermittently not appearing, which is
the point of the project.

**Fix:** the three session-start paths now use `scheduleAvailableCommands`, which defers
via `setImmediate` (not `queueMicrotask` — the result is written from a microtask
continuation, so a microtask would still land first). Result now precedes the update.

---

## Smaller items — all fixed

- **`copilot-runner.js`** — `chunk.toString()` on raw stdout chunks split multi-byte UTF-8
  across chunk boundaries. Now uses `setEncoding("utf8")` so Node's `StringDecoder` holds
  back partial characters; matters most for the JSON event forwarder, which line-parses
  that text.
- **`adapter.js`** — `reportedNativeActivities` only shrank on `session/close`, one entry
  per tool call forever. Now capped at 2000, oldest-first eviction.
- **`server.js`** — the mode rewrite keyed off `params.configId || params.id`, so any
  proxied request carrying `id: "mode"` was silently rewritten into `session/set_mode`.
  Now gated on the method actually being `session/set_config_option`.
- **`auth.js`** — the fallthrough treated any unrecognised first token as a hostname, so
  `/login gihub` ran `copilot login --host https://gihub`. Now validated: known modes and
  real-looking hostnames are accepted, anything else returns usage without launching a
  login.
- **`project-agents.js`** — with no frontmatter, `parseLooseMetadata` scanned the first 30
  lines of prose for `name:` / `description:`, so body text could be read as metadata. Now
  only the frontmatter block is trusted; the filename fallback still supplies a name.
- Removed dead code: `refreshNativeEnv`, the unreachable `isResponse` branch in
  `shouldProxyToNative`, and the `buildLogoutCommand` stub.

## Deliberately not changed

- **`server.js:nativeConfigModeMessage`** forwards without a `transformResponse`, so a
  client that sent `session/set_config_option` gets `session/set_mode`'s result shape
  rather than `{ configOptions }`. Reshaping it blind risks being wrong in a different
  direction; worth deciding once you know what `agent-shell` does with the response.
- **Session identity across a backend restart.** The adapter's session ids are the native
  ones, so after a relaunch the client's id no longer exists upstream. Remapping ids on
  every proxied message is a feature, not a bug fix — for now the restart message tells the
  user to start a new session.

## Still worth doing on your side

`.agent-shell/transcripts/` is untracked but not gitignored, one `git add -A` from being
committed. Since `/login api-key <token>` arrives as a *prompt*, a token may be sitting in
one of those files. Worth ignoring the directory and checking the existing contents.
