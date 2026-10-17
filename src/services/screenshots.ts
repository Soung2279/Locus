import { ipcInvoke } from "./ipc";
import type { ImageAttachment } from "../types";
import type { WorkspaceRef } from "./project";
import { readSharedComposerDraft, writeSharedComposerDraft } from "../composables/chatComposerDraftMemory";
import { useNotificationStore } from "../stores/notification";
import { t } from "../i18n";

interface ScreenshotAttachment {
  image: ImageAttachment;
  clipboardError?: string | null;
  spatialError?: string | null;
}

export function registerScreenshotInput(
  key: () => string,
  workspace: () => WorkspaceRef | null | undefined,
  add: (image: ImageAttachment) => boolean,
) {
  let disposed = false;
  let pending = false;
  return {
    async capture(target: "scene" | "game") {
      if (disposed || pending) return;
      const currentWorkspace = workspace();
      if (!currentWorkspace) throw new Error(t("capture.workspaceRequired"));
      const workspaceRef = { ...currentWorkspace };
      const draftKey = key();
      pending = true;
      try {
        const { image, clipboardError, spatialError } = await ipcInvoke<ScreenshotAttachment>("capture_unity_attachment", { workspaceRef, target });
        const received = !disposed && key() === draftKey
          && workspace()?.checkoutId === workspaceRef.checkoutId && add(image);
        if (!received && draftKey) {
          const draft = readSharedComposerDraft(draftKey) ?? {
            text: "", images: [], assetRefs: [], localFiles: [], consoleTexts: [],
            intent: { mode: "build" as const, skills: [] },
          };
          // Preserve the exact originating draft across tab switches and unmounts.
          if (!draft.images.some(item => item.capture?.id === image.capture?.id)) {
            draft.images.push(image);
            writeSharedComposerDraft(draftKey, draft);
          }
          useNotificationStore().addNotice("warning", t("capture.originalDraft"));
        }
        if (clipboardError) useNotificationStore().addNotice("warning", t("capture.clipboardFailed"));
        if (spatialError) useNotificationStore().addNotice("error", t("capture.spatialUnavailable", spatialError), { operation: "screenshot", replaceOperation: true });
      } finally {
        pending = false;
      }
    },
    dispose() { disposed = true; },
  };
}
