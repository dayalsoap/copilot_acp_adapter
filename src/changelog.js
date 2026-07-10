export const DEFAULT_CHANGELOG_URL =
  "https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md";

export async function fetchCopilotChangelog({
  fetchImpl = globalThis.fetch,
  url = DEFAULT_CHANGELOG_URL,
  timeoutMs = 5000,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch().");
  }

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`Changelog request failed with HTTP ${response.status}.`);
  }
  return response.text();
}

export function selectChangelog(markdown, rawArgs = "") {
  const args = String(rawArgs).trim().split(/\s+/).filter(Boolean);
  const summarize = args[0]?.toLowerCase() === "summarize";
  if (summarize) {
    args.shift();
  }

  const sections = splitVersionSections(markdown);
  if (!args.length || !sections.length) {
    return { text: markdown.trim(), summarize };
  }

  let selected = [];
  if (args[0].toLowerCase() === "last" && /^\d+$/.test(args[1] || "")) {
    selected = sections.slice(0, Number(args[1]));
  } else if (args[0].toLowerCase() === "since" && args[1]) {
    const index = sections.findIndex((section) => section.version === args[1]);
    selected = index < 0 ? [] : sections.slice(0, index + 1);
  } else {
    selected = sections.filter((section) => section.version === args[0]);
  }

  if (!selected.length) {
    throw new Error(`No Copilot CLI changelog entry matched: ${args.join(" ")}`);
  }
  return { text: selected.map((section) => section.text.trim()).join("\n\n"), summarize };
}

function splitVersionSections(markdown) {
  const matches = [...String(markdown).matchAll(/^##\s+([^\s]+).*$/gm)];
  return matches.map((match, index) => ({
    version: match[1],
    text: markdown.slice(match.index, matches[index + 1]?.index ?? markdown.length),
  }));
}
