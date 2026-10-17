import type { ViewPackageSummary } from "../../services/view";
import type { MentionSearchResult } from "./useMentionWorkspaceCandidates";

export function mapViewMentionResult(view: ViewPackageSummary, workspaceRoot: string): MentionSearchResult {
  const normalize = (path: string) => path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  // Single-component Views expose their Vue source as the manifest. Legacy
  // packages need the entire directory so their scripts and components remain accessible.
  const isSingleFile = /\.vue$/i.test(view.manifestPath);
  const path = normalize(isSingleFile ? view.manifestPath : view.packageRoot);
  const root = normalize(workspaceRoot);
  const relPath = root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? path.slice(root.length + 1)
    : path;
  const name = view.name.trim() || view.id;
  return {
    relPath,
    name,
    parentPath: relPath.slice(0, Math.max(0, relPath.lastIndexOf("/"))),
    meta: `View · ${view.displayPath || view.packageRelPath || view.id}`,
    matchScore: 0,
    entryKind: "view",
    viewIcon: view.icon,
    isDir: false,
    localFile: { path, name, isDir: !isSingleFile, typeLabel: "View", source: "local" },
  };
}
