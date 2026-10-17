import { inject, type InjectionKey } from "vue";
import type { WorkspaceRef } from "../services/project";
import { openViewPackage } from "../services/viewOpening";

// Shared child windows execute in their opener's JS context. Capture the
// containing Workbench instead of relying on Tauri's current webview.
export const VIEW_OPEN_WINDOW_KEY: InjectionKey<string> = Symbol("view-open-window");

export function useOpenView() {
  const windowLabel = inject(VIEW_OPEN_WINDOW_KEY, undefined);
  return (workspaceRef: WorkspaceRef, viewId: string) => openViewPackage(workspaceRef, viewId, windowLabel);
}
