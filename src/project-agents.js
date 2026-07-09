import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const AGENT_EXTENSIONS = new Set(["", ".json", ".md", ".markdown", ".yaml", ".yml"]);

export function discoverProjectAgents(cwd) {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    return { gitRoot: "", agentsDir: "", agents: [] };
  }

  const agentsDir = join(gitRoot, ".github", "agents");
  if (!existsSync(agentsDir)) {
    return { gitRoot, agentsDir, agents: [] };
  }

  const agents = [];
  for (const filePath of listAgentFiles(agentsDir)) {
    const metadata = readAgentMetadata(filePath);
    const fallbackName = basename(filePath, extname(filePath));
    const name = normalizeAgentName(metadata.name) || normalizeAgentName(fallbackName);
    if (!name) {
      continue;
    }
    agents.push({
      name,
      description: metadata.description || "",
      path: filePath,
      relativePath: relative(gitRoot, filePath),
      source: "project",
    });
  }

  agents.sort((left, right) => left.name.localeCompare(right.name));
  return { gitRoot, agentsDir, agents };
}

export function findGitRoot(startDir) {
  let current = resolve(startDir || process.cwd());
  if (!existsSync(current)) {
    current = dirname(current);
  }

  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return "";
    }
    current = parent;
  }
}

function listAgentFiles(agentsDir) {
  const files = [];
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = join(agentsDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listAgentFiles(entryPath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (AGENT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }
  return files;
}

function readAgentMetadata(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    if ([".json"].includes(extname(filePath).toLowerCase())) {
      const parsed = JSON.parse(text);
      return {
        name: parsed.name || parsed.id || "",
        description: parsed.description || "",
      };
    }

    return parseLooseMetadata(text);
  } catch {
    return {};
  }
}

function parseLooseMetadata(text) {
  const metadata = {};
  const frontmatter = String(text).match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  const source = frontmatter?.[1] || text.split(/\r?\n/).slice(0, 30).join("\n");

  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(name|id|description|title)\s*:\s*(.+?)\s*$/i);
    if (!match) {
      continue;
    }
    const key = match[1].toLowerCase();
    const value = unquote(match[2]);
    if (key === "name" || key === "id") {
      metadata.name ||= value;
    } else if (key === "description" || key === "title") {
      metadata.description ||= value;
    }
  }

  return metadata;
}

function normalizeAgentName(name) {
  const normalized = String(name || "").trim();
  return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : "";
}

function unquote(value) {
  const text = String(value || "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}
