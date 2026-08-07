export function activityStatusForTool(toolName, rawInput = {}, title = "") {
  const input = rawInput && typeof rawInput === "object" ? rawInput : {};
  const normalizedToolName = String(toolName || "").toLowerCase();
  const skillName = firstString(input.skill, input.skillName);
  const titleSkillName = String(title || "").match(/^using skill:\s*(.+)$/i)?.[1]?.trim();

  if (normalizedToolName === "skill" || skillName || titleSkillName) {
    const name = skillName || titleSkillName;
    return name ? `Enabling \`${name}\` skill.` : "Enabling skill.";
  }

  const agentName = firstString(
    input.agent_type,
    input.agentType,
    input.agent_name,
    input.agentName,
  );
  if (["task", "subagent", "delegate"].includes(normalizedToolName) || agentName) {
    return agentName
      ? `Delegating to \`${agentName}\` subagent.`
      : "Delegating to subagent.";
  }

  return "";
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}
