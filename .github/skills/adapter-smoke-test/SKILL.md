---
name: adapter-smoke-test
description: Run a deterministic, no-tool smoke test proving that GitHub Copilot can discover and invoke a project skill through the ACP adapter. Use only when explicitly invoked.
argument-hint: "[optional text to echo]"
disable-model-invocation: true
---

# Adapter smoke test

This skill verifies project-skill discovery and explicit slash-command invocation.

When invoked:

1. Do not call tools.
2. Do not edit files.
3. Reply with exactly these two plain-text lines, with no Markdown fence and no additional commentary:

   `COPILOT_SKILL_SMOKE_TEST=PASS`

   `INPUT=<invocation arguments>`

Replace `<invocation arguments>` with all text supplied after `/adapter-smoke-test`. If no text was supplied, use `(none)`.
