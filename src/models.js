export const DEFAULT_MODEL_IDS = Object.freeze([
  "auto",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "claude-fable-5",
  "claude-opus-4.8",
  "claude-opus-4.8-fast",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-opus-4.5",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gpt-5-mini",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "kimi-k2.7-code",
]);

export function parseModelCatalog(value) {
  if (Array.isArray(value)) {
    return uniqueModelIds(value);
  }

  const text = String(value || "").trim();
  if (!text) {
    return [...DEFAULT_MODEL_IDS];
  }

  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error("COPILOT_MODELS JSON value must be an array");
    }
    return uniqueModelIds(parsed);
  }

  return uniqueModelIds(text.split(/[,\s]+/));
}

export function modelDisplayName(modelId) {
  if (!modelId || modelId === "auto") {
    return "Auto";
  }

  return String(modelId)
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) {
        return "GPT";
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function uniqueModelIds(values) {
  const result = [];
  for (const value of values) {
    const modelId = String(value || "").trim();
    if (modelId && !result.includes(modelId)) {
      result.push(modelId);
    }
  }
  return result.includes("auto") ? result : ["auto", ...result];
}
