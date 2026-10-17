/**
 * Claude Code CLI is available through the native TUI bridge. Its models and
 * settings stay hidden until the user enables it in experimental settings
 * (see `services/claudeCodeCli`).
 */
export const claudeCodeProviderReleased = true;

export const hiddenProviderIds = new Set<string>(
  claudeCodeProviderReleased ? [] : ["claude_code"],
);

export const visibleProviderOrder = [
  "openrouter",
  "anthropic",
  "claude_code",
  "openai_codex",
  "custom",
  "mock",
] as const;

export function isProviderVisible(providerId: string): boolean {
  return !hiddenProviderIds.has(providerId);
}

export function filterVisibleProviders<T extends { id: string }>(providers: T[]): T[] {
  return providers.filter((provider) => isProviderVisible(provider.id));
}

export function filterVisibleModels<T extends { provider: string }>(models: T[]): T[] {
  return models.filter((model) => isProviderVisible(model.provider));
}
