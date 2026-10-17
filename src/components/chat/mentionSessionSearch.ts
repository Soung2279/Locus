import { t } from "../../i18n";
import type { SessionTitleMatch } from "../../services/session";
import { sessionReferenceUrl } from "../../composables/sessionReferences";
import type { MentionSearchResult } from "./useMentionWorkspaceCandidates";

export function mapSessionMentionResult(session: SessionTitleMatch): MentionSearchResult {
  return {
    relPath: sessionReferenceUrl(session.id),
    name: session.title.trim() || session.id,
    parentPath: "",
    meta: `${t(session.archived ? "chat.mention.archivedSession" : "chat.mention.session")} · ${session.id}`,
    isDir: false,
    matchScore: 0,
    entryKind: "session",
    updatedAt: session.updatedAt,
  };
}
