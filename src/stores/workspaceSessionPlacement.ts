import type { ProjectExplorerNode } from "../types/workbench";

/** Node fields that decide where a newly created session joins the layout. */
export type SessionPlacementNode = Pick<ProjectExplorerNode, "nodeId" | "resourceKind" | "resourceId"> & {
  hidden?: boolean;
};

export interface SessionInsertionRules<Node extends SessionPlacementNode = SessionPlacementNode> {
  /** A listed, shown and unpinned session that new sessions may be placed before. */
  isSessionAnchor(node: Node): boolean;
  /** An entry node such as Collaboration or Files that is currently shown in the tree. */
  isShownEntry(node: Node): boolean;
}

const NEW_SESSION_RESOURCE_ID = "newSession";

function isEntryNode(node: SessionPlacementNode): boolean {
  return node.resourceKind === "system" && node.resourceId !== NEW_SESSION_RESOURCE_ID;
}

/**
 * Index among ordered siblings where the next new session belongs.
 *
 * New sessions join the head of the session list below the last shown entry
 * node, so a session left between or above the entries does not capture every
 * later session. Without such a list the first anchor session wins, and an
 * empty list starts right after the leading entries and knowledge documents.
 */
export function newSessionInsertionIndex<Node extends SessionPlacementNode>(
  siblings: readonly Node[],
  newSessionIndex: number,
  rules: SessionInsertionRules<Node>,
): number {
  let sessionFollows = false;
  let entryBoundary = -1;
  for (let index = siblings.length - 1; index >= 0; index -= 1) {
    const node = siblings[index]!;
    if (rules.isSessionAnchor(node)) {
      sessionFollows = true;
    } else if (sessionFollows && isEntryNode(node) && rules.isShownEntry(node)) {
      entryBoundary = index;
      break;
    }
  }
  const anchor = siblings.findIndex((node, index) => index > entryBoundary && rules.isSessionAnchor(node));
  if (anchor >= 0) return anchor;
  let index = Math.max(0, newSessionIndex + 1);
  while (index < siblings.length) {
    const node = siblings[index]!;
    if (node.resourceKind !== "system" && node.resourceKind !== "knowledge") break;
    index += 1;
  }
  return index;
}
