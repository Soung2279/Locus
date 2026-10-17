import { knowledgeListPage, knowledgeQuery } from "../../../services/knowledge";
import { listDirEntriesPage, searchWorkspaceEntries, type WorkspaceRef } from "../../../services/project";
import { searchWorkspaceAssets } from "../../../services/asset";
import { relativeMarkdownResource } from "../../../services/markdownImage";
import { rankMentionSearchResults, type MentionSearchRankable } from "../../chat/mentionSearchRanking";
import { serializeMarkdownEdit } from "./markdownEditTarget";

export interface MarkdownMentionResource extends MentionSearchRankable {
  /** Physical workspace path, including the knowledge root when applicable. */
  relPath: string;
}

export function isMarkdownMentionImage(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(path);
}

export async function searchMarkdownMentionResources(query: string, workspaceRef: WorkspaceRef): Promise<MarkdownMentionResource[]> {
  const term = query.trim();
  const jobs = await Promise.allSettled([
    term ? searchWorkspaceEntries(term, workspaceRef, 100)
      : listDirEntriesPage("", workspaceRef, 0, 100, true).then(page => page.entries),
    searchWorkspaceAssets(term, ["Assets", "Packages", "ProjectSettings"], 100, workspaceRef),
    term ? knowledgeQuery({ query: term, limit: 40 }, workspaceRef)
      : knowledgeListPage({ limit: 40 }, workspaceRef).then(page => page.items),
  ]);
  if (jobs.every(job => job.status === "rejected")) throw new Error("资源搜索失败");
  const resources: MarkdownMentionResource[] = [];
  function add(path: string, name: string, entryKind: "asset" | "knowledge", score = 0, meta?: string) {
    const relPath = path.replace(/\\/g, "/");
    if (/\.meta$/i.test(relPath)) return;
    resources.push({ relPath, name: name.trim() || relPath.split("/").pop() || relPath,
      parentPath: relPath.slice(0, Math.max(0, relPath.lastIndexOf("/"))), entryKind, matchScore: score, meta });
  }
  if (jobs[0].status === "fulfilled") for (const item of jobs[0].value) {
    if (!item.isDir) add(item.relPath, item.name, "asset", "matchScore" in item && typeof item.matchScore === "number" ? item.matchScore : 0);
  }
  if (jobs[1].status === "fulfilled") for (const item of jobs[1].value) {
    if (!item.isDirectory) add(item.path, item.name, "asset", item.matchScore);
  }
  if (jobs[2].status === "fulfilled") for (const item of jobs[2].value) {
    if ((item.storageSource ?? "project") !== "project") continue;
    const path = item.path.replace(/\\/g, "/");
    add(path.startsWith("Locus/knowledge/") ? path : `Locus/knowledge/${path.startsWith(`${item.type}/`) ? path : `${item.type}/${path}`}`,
      item.title, "knowledge", "score" in item ? item.score : 0, "snippet" in item ? item.snippet : undefined);
  }
  const ranked = rankMentionSearchResults(resources, term, 60);
  // Full-text knowledge hits can match the body even when the title/path do not.
  const seen = new Set(ranked.map(item => item.relPath.toLowerCase()));
  for (const item of resources) {
    if (item.entryKind === "knowledge" && !seen.has(item.relPath.toLowerCase())) {
      ranked.push(item); seen.add(item.relPath.toLowerCase());
    }
  }
  return ranked.slice(0, 60);
}

export async function markdownMentionText(resource: MarkdownMentionResource, workspaceRef: WorkspaceRef, contentPath: string): Promise<string> {
  const url = await relativeMarkdownResource(workspaceRef, contentPath || "untitled.md", resource.relPath);
  const image = isMarkdownMentionImage(resource.relPath);
  // Titles and filenames are plain labels, never Markdown supplied by the search provider.
  const label = resource.name.replace(/[\r\n]/g, " ");
  const escaped = label.replace(/&/g, "&amp;").replace(/([\\`*_~[\]<>|])/g, "\\$1");
  const link = serializeMarkdownEdit({ kind: "link", from: 0, to: 0, source: "", url: "", label: escaped }, url, escaped);
  return `${image ? "!" : ""}${link}`;
}
