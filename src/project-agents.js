import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const AGENT_EXTENSIONS = new Set(["", ".json", ".md", ".markdown", ".yaml", ".yml"]);
const SKILL_EXTENSIONS = new Set(["", ".md", ".markdown"]);

export function discoverProjectAgents(cwd) {
  return discoverProjectResources(cwd, {
    kind: "agent",
    directories: [[".github", "agents"]],
    extensions: AGENT_EXTENSIONS,
  });
}

export function discoverProjectSkills(cwd) {
  return discoverProjectResources(cwd, {
    kind: "skill",
    directories: [
      [".github", "skills"],
      [".agents", "skills"],
      [".claude", "skills"],
    ],
    extensions: SKILL_EXTENSIONS,
  });
}

function discoverProjectResources(cwd, { kind, directories, extensions }) {
  const searchRoot = resolve(cwd || process.cwd());
  const cwdResult = discoverResourcesInRoot(searchRoot, searchRoot, directories, extensions, kind);
  if (cwdResult.resources.length > 0) {
    return {
      gitRoot: findGitRoot(searchRoot),
      searchRoot,
      directories: cwdResult.directories,
      agentsDir: kind === "agent" ? cwdResult.directories[0] : "",
      skillsDirs: kind === "skill" ? cwdResult.directories : [],
      agents: kind === "agent" ? cwdResult.resources : [],
      skills: kind === "skill" ? cwdResult.resources : [],
    };
  }

  const gitRoot = findGitRoot(searchRoot);
  if (!gitRoot) {
    return {
      gitRoot: "",
      searchRoot,
      directories: cwdResult.directories,
      agentsDir: kind === "agent" ? cwdResult.directories[0] : "",
      skillsDirs: kind === "skill" ? cwdResult.directories : [],
      agents: [],
      skills: [],
    };
  }

  if (gitRoot === searchRoot) {
    return {
      gitRoot,
      searchRoot,
      directories: cwdResult.directories,
      agentsDir: kind === "agent" ? cwdResult.directories[0] : "",
      skillsDirs: kind === "skill" ? cwdResult.directories : [],
      agents: [],
      skills: [],
    };
  }

  const gitRootResult = discoverResourcesInRoot(gitRoot, gitRoot, directories, extensions, kind);
  return {
    gitRoot,
    searchRoot: gitRoot,
    directories: gitRootResult.directories,
    agentsDir: kind === "agent" ? gitRootResult.directories[0] : "",
    skillsDirs: kind === "skill" ? gitRootResult.directories : [],
    agents: kind === "agent" ? gitRootResult.resources : [],
    skills: kind === "skill" ? gitRootResult.resources : [],
  };
}

function discoverResourcesInRoot(root, relativeRoot, directoryParts, extensions, kind) {
  const directories = directoryParts.map((parts) => join(root, ...parts));
  const resources = [];

  for (const directory of directories) {
    if (!existsSync(directory)) {
      continue;
    }

    for (const filePath of listResourceFiles(directory, extensions)) {
      const metadata = readAgentMetadata(filePath);
      const fallbackName = fallbackResourceName(filePath, kind);
      const name = normalizeAgentName(metadata.name) || normalizeAgentName(fallbackName);
      if (!name) {
        continue;
      }
      resources.push({
        name,
        description: metadata.description || "",
        path: filePath,
        relativePath: relative(relativeRoot, filePath),
        source: "project",
        kind,
      });
    }
  }

  resources.sort((left, right) => left.name.localeCompare(right.name));
  return { directories, resources };
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

function listResourceFiles(directory, extensions) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listResourceFiles(entryPath, extensions));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (extensions.has(extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }
  return files;
}

function fallbackResourceName(filePath, kind) {
  const base = basename(filePath, extname(filePath));
  if (kind === "skill" && base.toLowerCase() === "skill") {
    return basename(dirname(filePath));
  }
  return base;
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
