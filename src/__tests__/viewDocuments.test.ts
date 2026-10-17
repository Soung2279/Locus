// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ipc from "../services/ipc";
import * as runtime from "../services/locusRuntime";
import { createViewDocuments, splitViewDocument, type ViewDocumentRef } from "../services/viewDocuments";
import { executeFrontendTypeScript } from "../services/frontendExecution";
import type { RoutedWorkspaceEvent } from "../services/project";

const scope = { checkoutId: "docs", expectedGeneration: 3, expectedMaterializationEpoch: 7 };
const reference: ViewDocumentRef = { kind: "workspace", path: "Docs/character.md" };
function backend(initial: string, extra = {}) {
  let content = initial;
  let revision = 1;
  const invoke = vi.spyOn(ipc, "ipcInvoke").mockImplementation(async (command, args) => {
    expect(args?.workspaceRef).toEqual(scope);
    if (command === "view_document_write") {
      const request = args!.request as { content: string; expectedRevision: string };
      if (request.expectedRevision !== String(revision)) throw { code: "document.conflict", message: "Changed while saving" };
      content = request.content; revision++;
    } else if (command !== "view_document_read") throw new Error(`Unexpected command: ${command}`);
    return { reference, path: "F:/project/Docs/character.md", content, revision: String(revision), readOnly: false, reservedKeys: [], ...extra };
  });
  return { invoke, source: () => content, externallyWrite: (text: string) => { content = text; revision++; } };
}
afterEach(() => vi.restoreAllMocks());

describe("View document SDK", () => {
  it("edits typed properties while preserving BOM, comments, CRLF and exact body bytes", async () => {
    const body = "\r\n# 艾洛拉\r\n\r\n正文  \r\n";
    const store = backend('\ufeff---\r\n# 属性\r\n等级: 12 # 注释\r\n代号: "007"\r\n---\r\n' + body);
    const docs = createViewDocuments(scope);
    const before = await docs.read(reference);
    expect(before.body).toBe(body);
    const saved = await docs.setProperties(before.reference, { 等级: 15, 完成: false, 别名: ["true", "007"] }, { expectedRevision: before.revision });
    expect(saved.properties).toEqual({ 等级: 15, 代号: "007", 完成: false, 别名: ["true", "007"] });
    expect(saved.body).toBe(body);
    expect(store.source()).toContain("等级: 15 # 注释\r\n");
    expect(store.source().startsWith("\ufeff---\r\n# 属性\r\n")).toBe(true);
    expect(store.source()).not.toMatch(/(?<!\r)\n/);
  });

  it("adds frontmatter without consuming the body, and changes body without reserializing metadata", async () => {
    const store = backend("\ufeff# Original\n");
    const docs = createViewDocuments(scope);
    let saved = await docs.setProperties(reference, { status: "todo", value: null }, { expectedRevision: "1" });
    expect(saved.body).toBe("# Original\n");
    const originalPrefix = store.source().slice(0, -saved.body.length);
    saved = await docs.writeBody(saved.reference, "# Updated\n\n", { expectedRevision: saved.revision });
    expect(store.source()).toBe(originalPrefix + "# Updated\n\n");
    saved = await docs.removeProperties(saved.reference, ["value"], { expectedRevision: saved.revision });
    expect(saved.properties).toEqual({ status: "todo" });
    expect(saved.body).toBe("# Updated\n\n");
  });

  it("renames properties and edits body in one version-checked write", async () => {
    const store = backend("---\nname: Elora\n...\n# Body\n");
    const saved = await createViewDocuments(scope).update(reference, { properties: [{ key: "name", newKey: "title" }], body: "# New\n" }, { expectedRevision: "1" });
    expect(saved.properties).toEqual({ title: "Elora" });
    expect(store.source()).toContain("...\n# New\n");
    expect(store.invoke.mock.calls.filter(([name]) => name === "view_document_write")).toHaveLength(1);
  });

  it("requires a revision and rejects stale edits without writing", async () => {
    const store = backend("---\nstatus: todo\n---\n# Body\n");
    const docs = createViewDocuments(scope);
    const loaded = await docs.read(reference);
    store.externallyWrite("---\nstatus: done\n---\n# Agent edit\n");
    await expect(docs.setProperties(reference, { status: "paused" }, { expectedRevision: loaded.revision })).rejects.toMatchObject({ code: "document.conflict" });
    await expect(docs.writeBody(reference, "new", { expectedRevision: "" })).rejects.toMatchObject({ code: "document.revision_required" });
    expect(store.invoke.mock.calls.some(([name]) => name === "view_document_write")).toBe(false);
    expect(store.source()).toContain("# Agent edit");
  });

  it("preserves the resolved knowledge source and refuses reserved fields", async () => {
    const resolved = { kind: "knowledge", type: "design", path: "role.md", sourceId: "workspace-knowledge:design" };
    const store = backend("---\nid: kd_1\nstatus: todo\n---\nbody", { reference: resolved, reservedKeys: ["id", "readOnly"] });
    const docs = createViewDocuments(scope);
    const ref = docs.knowledge("design", "role.md");
    await expect(docs.setProperties(ref, { id: "other" }, { expectedRevision: "1" })).rejects.toMatchObject({ code: "document.reserved_property" });
    await expect(docs.update(ref, { properties: [{ key: "status", newKey: "readOnly" }] }, { expectedRevision: "1" })).rejects.toMatchObject({ code: "document.reserved_property" });
    await docs.setProperties(ref, { status: "done" }, { expectedRevision: "1" });
    expect(store.invoke).toHaveBeenLastCalledWith("view_document_write", expect.objectContaining({ request: expect.objectContaining({ reference: resolved, expectedRevision: "1" }) }));
  });

  it("does not write read-only, malformed YAML, duplicate keys or unsupported property values", async () => {
    const docs = createViewDocuments(scope);
    let store = backend("---\nx: 1\n---\n", { readOnly: true });
    await expect(docs.setProperties(reference, { x: 2 }, { expectedRevision: "1" })).rejects.toMatchObject({ code: "document.read_only" });
    store.invoke.mockRestore();
    for (const content of ["---\na: [broken\n---\n", "---\na: 1\na: 2\n---\n", "---\nnot closed"]) {
      store = backend(content);
      await expect(docs.setProperties(reference, { x: 2 }, { expectedRevision: "1" })).rejects.toThrow();
      expect(store.invoke.mock.calls.some(([name]) => name === "view_document_write")).toBe(false);
      store.invoke.mockRestore();
    }
    store = backend("# Body\n");
    await expect(docs.setProperties(reference, { x: Infinity }, { expectedRevision: "1" })).rejects.toMatchObject({ code: "document.invalid_value" });
    expect(splitViewDocument("# Body\n---\n").hasProperties).toBe(false);
  });

  it("lists workspace Markdown and directory continuation without treating CSV as a document", async () => {
    const invoke = vi.spyOn(ipc, "ipcInvoke").mockResolvedValue({ entries: [
      { name: "one.md", relPath: "Docs/one.md", isDir: false },
      { name: "table.csv", relPath: "Docs/table.csv", isDir: false },
      { name: "Nested", relPath: "Docs/Nested", isDir: true },
    ], hasMore: true, nextOffset: 3, totalCount: 6 });
    const page = await createViewDocuments(scope).list({ kind: "workspace", path: "Docs", limit: 3 });
    expect(page).toEqual({ items: [{ reference: { kind: "workspace", path: "Docs/one.md" }, title: "one.md" }], directories: ["Docs/Nested"], nextCursor: "3" });
    expect(invoke).toHaveBeenCalledWith("list_dir_entries_page", expect.objectContaining({ workspaceRef: scope, subPath: "Docs", offset: 0, limit: 3 }));
  });

  it("binds notifications and cancellation to the originating checkout and View lifetime", async () => {
    let deliver!: (event: RoutedWorkspaceEvent<Record<string, unknown>>) => void;
    const release = vi.fn();
    const controller = new AbortController();
    vi.spyOn(runtime, "getLocusRuntime").mockReturnValue({ kind: "tauri", invoke: vi.fn(), subscribe: vi.fn(async (_name, callback, options) => {
      deliver = callback as typeof deliver;
      options?.signal?.addEventListener("abort", release, { once: true });
      return release;
    }) });
    const docs = createViewDocuments(scope, { signal: controller.signal });
    const handler = vi.fn();
    await docs.onChanged(handler);
    const event = { eventName: "view-document-changed", projectId: "p", checkoutId: "docs", workspaceGeneration: 3, materializationEpoch: 7, streamRevision: 1, payload: { reference, path: "Docs/character.md" } };
    deliver({ ...event, checkoutId: "other" });
    deliver({ ...event, materializationEpoch: 6 });
    expect(handler).not.toHaveBeenCalled();
    deliver(event);
    expect(handler).toHaveBeenCalledTimes(1);
    controller.abort(); deliver(event);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledOnce();
    await expect(docs.read(reference)).rejects.toMatchObject({ code: "document.cancelled" });
  });

  it("exposes document edits through the actual frontend TypeScript SDK", async () => {
    const store = backend("---\nlevel: 1\n---\n# Role\n");
    const result = await executeFrontendTypeScript(`
      import { locus } from "@locus/frontend";
      const ref = locus.documents.workspace("Docs/character.md");
      const doc = await locus.documents.read(ref);
      const saved = await locus.documents.setProperties(doc.reference, { level: 2 }, { expectedRevision: doc.revision });
      return { level: saved.properties.level, body: saved.body };
    `, scope);
    expect(result.result).toEqual({ level: 2, body: "# Role\n" });
    expect(store.source()).toContain("level: 2");
  });
});
