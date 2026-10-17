import type { SessionSummary } from "../../types";
import { listProjectSessions } from "../../services/session";

export async function resolveWorkbenchSessionAvailability(
  projectId: string,
  sessionId: string,
  cachedSessions: readonly SessionSummary[] = [],
): Promise<boolean> {
  if (cachedSessions.some((session) => session.id === sessionId)) return true;

  // A newly created session can reach its editor before the explorer catalog
  // refreshes. Only an authoritative miss may replace the live chat surface.
  // Let lookup failures preserve the editor through the reconciliation catch.
  const sessions = await listProjectSessions(projectId);
  return sessions.some((session) => session.id === sessionId);
}
