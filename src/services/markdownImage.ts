import { ipcInvoke } from "./ipc";
import type { WorkspaceRef } from "./project";

export interface MarkdownImagePreview {
  url: string;
  mimeType: string;
  byteSize: number;
  displayPath: string;
}

export function resolveMarkdownImage(workspaceRef: WorkspaceRef, source: string, contentPath?: string): Promise<MarkdownImagePreview> {
  return ipcInvoke<MarkdownImagePreview>("resolve_markdown_image", { workspaceRef, source, ...(contentPath ? { contentPath } : {}) });
}

export interface ImportedMarkdownImage { path: string; relativePath: string }
export function relativeMarkdownResource(workspaceRef: WorkspaceRef, contentPath: string, targetPath: string): Promise<string> {
  return ipcInvoke("markdown_relative_path", { workspaceRef, contentPath, targetPath });
}
export async function importMarkdownImage(workspaceRef: WorkspaceRef, contentPath: string, source: File | string): Promise<ImportedMarkdownImage> {
  if (typeof source === "string") return ipcInvoke("markdown_import_image", { workspaceRef, contentPath, name: source, sourcePath: source });
  if (source.size > 20 * 1024 * 1024) throw new Error("图片不能超过 20 MiB");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(source);
  });
  return ipcInvoke("markdown_import_image", { workspaceRef, contentPath, name: source.name, data });
}

export function rewriteMarkdownImageLinks(workspaceRef: WorkspaceRef, contentPath: string, text: string, oldPath: string, newPath: string): Promise<string> {
  return ipcInvoke("markdown_rewrite_image_links", { workspaceRef, contentPath, text, oldPath, newPath });
}
