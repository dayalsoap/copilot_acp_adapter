---
name: adapter-resource-test
description: Verify that a GitHub Copilot project skill invoked through the ACP adapter can load a supporting resource stored beside SKILL.md. Use only when explicitly invoked.
disable-model-invocation: true
---

# Adapter bundled-resource test

This skill verifies that Copilot can resolve and read supporting files bundled with a skill.

When invoked:

1. Read `expected-marker.txt` from this skill's base directory.
2. Do not edit any files.
3. Reply with the file's single marker line exactly as written, with no Markdown fence and no additional commentary.

If the resource cannot be read, reply exactly:

`COPILOT_SKILL_RESOURCE_TEST=FAIL`
