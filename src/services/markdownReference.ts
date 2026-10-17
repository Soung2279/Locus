import type { MarkdownReferenceToken } from "../components/ui/markdown-editor/markdownComplexTokens";
import type { WorkspaceRef } from "./project";
import { openWorkbenchFileTab, type WorkbenchFileOpenRequest } from "./workbenchFile";
import { openUnityAssetInspector, openUnitySceneObjectInspector, showInFolder } from "./unity";
import { viewTree } from "./view";
import { openViewPackage } from "./viewOpening";
import { parseUnityPropertyFence, unityPropertyFenceUnitySelectionTarget } from "../composables/unityPropertyFence";

export async function openMarkdownReference(reference: MarkdownReferenceToken, workspaceRef: WorkspaceRef,
  openFile: (request: WorkbenchFileOpenRequest) => Promise<void> = openWorkbenchFileTab,
  openKnowledge?: (reference: MarkdownReferenceToken) => Promise<void>,
  openView: (workspaceRef: WorkspaceRef, viewId: string) => Promise<void> = openViewPackage,
): Promise<void> {
  if (reference.kind === "knowledge" && openKnowledge) return openKnowledge(reference);
  if (reference.kind === "view") {
    const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    const snapshot = await viewTree(workspaceRef);
    const view = snapshot.views.find(item => [item.id, item.displayPath, item.packageRelPath, item.name].some(value => value && normalize(value) === normalize(reference.path)));
    await openView(workspaceRef, view?.id ?? reference.path); return;
  }
  if (reference.kind === "unity-property") {
    const entry = parseUnityPropertyFence(reference.raw).entries[0];
    const target = entry ? unityPropertyFenceUnitySelectionTarget(entry.target) : null;
    if (target?.kind === "sceneObject") { await openUnitySceneObjectInspector(workspaceRef, target.scenePath, target.objectPath); return; }
    if (target?.kind === "asset") { await openUnityAssetInspector(workspaceRef, target.path); return; }
  }
  const path = reference.path.replace(/\\/g, "/");
  if (reference.kind.startsWith("unity-")) {
    const scene = path.match(/^((?:Assets|Packages)\/.+?\.unity)\/(.+)$/i);
    if (scene) await openUnitySceneObjectInspector(workspaceRef, scene[1]!, scene[2]!);
    else await openUnityAssetInspector(workspaceRef, path.replace(/#fileID:-?\d+$/i, ""));
    return;
  }
  if (/\/$/.test(reference.raw.trim())) { await showInFolder(workspaceRef, path); return; }
  const filePath = reference.kind === "knowledge" && !path.startsWith("Locus/knowledge/") ? `Locus/knowledge/${path}` : path;
  await openFile({ workspaceRef, filePath });
}

export function relativeMarkdownPath(document: string, target: string): string {
  if (/^(?:[a-z]:[\\/]|\/)/i.test(target)) return target;
  const parts = document.replace(/\\/g, "/").split("/"); parts.pop();
  for (const part of target.replace(/\\/g, "/").split("/")) {
    if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
