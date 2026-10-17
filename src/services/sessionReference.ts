import { openChatSessionWindow } from "./chatSessionWindow";
import { useNotificationStore } from "../stores/notification";
import { normalizeAppError } from "./errors";
import { t } from "../i18n";

export async function openSessionReference(sessionId: string, title: string): Promise<void> {
  try {
    if (!await openChatSessionWindow({ sessionId, title })) throw new Error("Session window unavailable");
  } catch (error) {
    useNotificationStore().addNotice("error", t("chat.sessionRef.openFailed", normalizeAppError(error).message), {
      operation: "openSessionReference", replaceOperation: true,
    });
  }
}
