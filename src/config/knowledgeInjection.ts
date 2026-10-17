/** `injectAgents` pattern that matches every Agent. */
export const ALL_AGENTS_INJECT_PATTERN = "*";

/** Targets of a document without `injectAgents` metadata. Mirrors `knowledge_store::legacy_inject_agents`. */
export const LEGACY_KNOWLEDGE_INJECT_AGENTS: readonly string[] = ["unity"];

export function legacyKnowledgeInjectAgents(): string[] {
  return [...LEGACY_KNOWLEDGE_INJECT_AGENTS];
}

export function isInjectAgentPattern(value: string): boolean {
  return value.includes("*");
}

/** Mirrors `knowledge_store::inject_agent_pattern_matches`: `*` matches any character sequence. */
export function injectAgentPatternMatches(pattern: string, agentId: string): boolean {
  const normalizedPattern = pattern.trim();
  const normalizedAgent = agentId.trim();
  if (!isInjectAgentPattern(normalizedPattern)) return normalizedPattern === normalizedAgent;
  const parts = normalizedPattern.split("*");
  const prefix = parts.shift() ?? "";
  const suffix = parts.pop() ?? "";
  if (!normalizedAgent.startsWith(prefix)) return false;
  let rest = normalizedAgent.slice(prefix.length);
  for (const part of parts) {
    if (!part) continue;
    const index = rest.indexOf(part);
    if (index < 0) return false;
    rest = rest.slice(index + part.length);
  }
  return rest.length >= suffix.length && rest.endsWith(suffix);
}
