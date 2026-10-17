import { onBeforeUnmount } from "vue";
import { useInternalDropTarget, type InternalDragSource } from "./useInternalDrag";
import { useNotificationStore } from "../stores/notification";
import { normalizeAppError } from "../services/errors";
import type { WorkspaceRef } from "../services/project";
import { workspaceOrderDirectory } from "../components/explorer/workspaceFileOrder";

export interface WorkspaceOrderDragItem {
  item: string;
  projectId: string;
  workspaceRef: WorkspaceRef;
}
export interface WorkspaceOrderDropRow extends WorkspaceOrderDragItem {
  element: HTMLElement;
  folder: boolean;
  /** Reserve the row center for an action such as attaching to a new session. */
  insideDrop?: boolean;
}

/** The same row edges used by session sorting; a folder's center remains a
 * filesystem drop target handled by useWorkspaceFileDrop. */
export function useWorkspaceFileOrderDrop(options: {
  root: () => HTMLElement | null;
  source: (source: InternalDragSource) => WorkspaceOrderDragItem | null;
  row: (hit: Element) => WorkspaceOrderDropRow | null;
  move: (source: WorkspaceOrderDragItem, anchor: string, side: "before" | "after") => Promise<void>;
}) {
  const notifications = useNotificationStore();
  let busy = false, highlighted: HTMLElement | null = null;
  function clear() { highlighted?.classList.remove("is-pin-drop-before", "is-pin-drop-after"); highlighted = null; }
  onBeforeUnmount(clear);
  useInternalDropTarget<unknown, { source: WorkspaceOrderDragItem; row: WorkspaceOrderDropRow; side: "before" | "after" }>({
    id: `workspace-file-order:${crypto.randomUUID()}`, root: options.root, priority: 40,
    accepts: source => !busy && !!options.source(source),
    resolve: ({ source, hit, point }) => {
      const from = options.source(source), row = options.row(hit);
      if (!from || !row || from.item === row.item || from.projectId !== row.projectId
        || from.workspaceRef.checkoutId !== row.workspaceRef.checkoutId
        || from.workspaceRef.expectedGeneration !== row.workspaceRef.expectedGeneration
        || from.workspaceRef.expectedMaterializationEpoch !== row.workspaceRef.expectedMaterializationEpoch
        || workspaceOrderDirectory(from.item) !== workspaceOrderDirectory(row.item)) return null;
      const bounds = row.element.getBoundingClientRect();
      const ratio = bounds.height ? (point.y - bounds.top) / bounds.height : 0.5;
      if ((row.folder || row.insideDrop) && ratio >= 0.25 && ratio <= 0.75) return null;
      const side = ratio < 0.5 ? "before" : "after";
      return { key: `file-order:${row.workspaceRef.checkoutId}:${row.item}:${side}`, operation: "move",
        intent: { source: from, row, side }, previewMode: "floating" };
    },
    onTargetChange: decision => {
      clear();
      if (decision) { highlighted = decision.intent.row.element; highlighted.classList.add(`is-pin-drop-${decision.intent.side}`); }
    },
    drop: async ({ decision }) => {
      busy = true;
      try { await options.move(decision.intent.source, decision.intent.row.item, decision.intent.side); }
      catch (error) { notifications.addNotice("error", normalizeAppError(error).message); }
      finally { busy = false; }
    },
  });
}
