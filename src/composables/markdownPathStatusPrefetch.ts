import { getActivePinia } from "pinia";
import { useProjectStore } from "../stores/project";
import { useWorkspaceContextStore } from "../stores/workspaceContext";
import { collectMarkdownInlineCodePathCandidates } from "./markdownInject";
import { prefetchMarkdownPathStatuses } from "./markdownPathStatusCache";

interface MarkdownMessageSource {
  content?: string | null;
  thinkingContent?: string | null;
}

/**
 * Resolves the inline path statuses of messages before they are rendered, in
 * the scope MarkdownRenderer reads. A transcript then renders its file
 * references once, in the first frame, instead of rendering code spans and
 * re-rendering every message when the statuses arrive.
 *
 * Returns null when nothing has to be fetched, so callers stay synchronous.
 */
export function prefetchMessagePathStatuses(
  messages: readonly MarkdownMessageSource[],
): Promise<void> | null {
  if (!getActivePinia()) return null;
  const workspaceRef = useWorkspaceContextStore().focusedWorkspaceRef;
  if (!workspaceRef) return null;
  const candidates = new Set<string>();
  for (const message of messages) {
    for (const source of [message.content, message.thinkingContent]) {
      if (!source) continue;
      for (const candidate of collectMarkdownInlineCodePathCandidates(source)) candidates.add(candidate);
    }
  }
  if (candidates.size === 0) return null;
  return prefetchMarkdownPathStatuses(useProjectStore().workingDir, [...candidates], workspaceRef);
}
