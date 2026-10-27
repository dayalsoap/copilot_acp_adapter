// Copilot titles sessions with the first prompt verbatim; embedded newlines make
// single-line session pickers (e.g. agent-shell under helm) unreadable. Native
// session/list still returns such titles as of Copilot CLI 1.0.104.
export function normalizeSessionTitle(title) {
  return typeof title === "string" ? title.replace(/\s+/g, " ").trim() : title;
}

export function normalizeSessionListResult(result) {
  if (!Array.isArray(result?.sessions)) return result;
  return {
    ...result,
    sessions: result.sessions.map((session) =>
      typeof session?.title === "string" ? { ...session, title: normalizeSessionTitle(session.title) } : session),
  };
}
