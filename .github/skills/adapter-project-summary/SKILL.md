---
name: adapter-project-summary
description: Inspect this repository and summarize the Copilot ACP adapter architecture. Use when the user asks for an adapter architecture summary, repository tour, or a test of project-file access through a Copilot skill.
argument-hint: "[optional area to emphasize]"
---

# Copilot ACP adapter project summary

Use this skill to test automatic skill selection and read-only repository inspection.

## Procedure

1. Read `package.json`, `src/adapter.js`, `src/copilot-runner.js`, and `src/project-agents.js` from the current repository.
2. If invocation arguments specify an area to emphasize, prioritize that area while still covering the required sections.
3. Do not edit files and do not run commands that change repository state.
4. Base the answer only on files you inspected. If a required file is unavailable, say so rather than guessing.

## Response format

Return a concise summary with exactly these Markdown headings:

- `## ACP boundary`
- `## Copilot CLI execution`
- `## Skill discovery`
- `## Best next test`

Under each heading, provide one to three bullets. Mention concrete file paths in backticks. Under `Best next test`, recommend one specific Emacs agent-shell test.
