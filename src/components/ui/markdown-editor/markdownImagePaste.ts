import { Prec } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import type { WorkspaceRef } from "../../../services/project";
import { importMarkdownImage } from "../../../services/markdownImage";
import { hasTauriWindowRuntime } from "../../../services/tauriRuntime";

export function markdownImagePaste(options: {
  context: () => { workspaceRef: WorkspaceRef; contentPath: string; key: string } | null;
  onError: (error: unknown) => void;
}) {
  return Prec.highest(ViewPlugin.fromClass(class {
    pending = new Set<{ from: number; to: number; cancelled: boolean }>();
    disposed = false;
    unlisten: (() => void) | null = null;
    constructor(readonly view: EditorView) {
      if (hasTauriWindowRuntime()) void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent(event => {
        if (this.disposed || event.payload.type !== "drop" || this.view.state.readOnly) return;
        const x = event.payload.position.x / window.devicePixelRatio;
        const y = event.payload.position.y / window.devicePixelRatio;
        if (!this.view.dom.contains(document.elementFromPoint(x, y))) return;
        const files = event.payload.paths.filter(path => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path));
        if (files.length) this.importAt(files, this.view.posAtCoords({ x, y }));
      })).then(release => { if (this.disposed) release(); else this.unlisten = release; }).catch(options.onError);
    }
    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      for (const range of this.pending) {
        if (range.from !== range.to && update.changes.touchesRange(range.from, range.to)) range.cancelled = true;
        range.from = update.changes.mapPos(range.from, 1);
        range.to = Math.max(range.from, update.changes.mapPos(range.to, -1));
      }
    }
    destroy() { this.disposed = true; this.unlisten?.(); }
    receive(event: ClipboardEvent | DragEvent) {
      const data = "clipboardData" in event ? event.clipboardData : event.dataTransfer;
      const files = Array.from(data?.files ?? []).filter(file => file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name));
      if (!options.context() || this.view.state.readOnly || !files.length) return false;
      event.preventDefault(); event.stopPropagation();
      const position = "clientX" in event ? this.view.posAtCoords({ x: event.clientX, y: event.clientY }) : null;
      this.importAt(files, position);
      return true;
    }
    importAt(files: (File | string)[], position: number | null) {
      const current = options.context();
      const context = current ? { ...current, workspaceRef: { ...current.workspaceRef } } : null;
      if (!context) return;
      const selection = this.view.state.selection.main;
      const range = { from: position ?? selection.from, to: position ?? selection.to, cancelled: false };
      this.pending.add(range);
      void Promise.all(files.map(file => importMarkdownImage(context.workspaceRef, context.contentPath, file)))
        .then(images => {
          if (this.disposed || range.cancelled || this.view.state.readOnly || options.context()?.key !== context.key) return;
          // Images are standalone blocks. A bare insertion at the end of a
          // reference definition/list marker can otherwise change Markdown syntax.
          const doc = this.view.state.doc;
          const before = doc.sliceString(doc.lineAt(range.from).from, range.from).trim();
          const after = doc.sliceString(range.to, doc.lineAt(range.to).to).trim();
          const insert = `${before ? "\n\n" : ""}${images.map(image => `![图片](${image.relativePath})`).join("\n\n")}${after ? "\n\n" : "\n"}`;
          this.pending.delete(range);
          const atSelection = this.view.state.selection.main.from === range.from && this.view.state.selection.main.to === range.to;
          this.view.dispatch({ changes: { from: range.from, to: range.to, insert },
            ...(atSelection ? { selection: { anchor: range.from + insert.length } } : {}),
            annotations: isolateHistory.of("full"), userEvent: "input.paste", scrollIntoView: atSelection });
        }).catch(options.onError).finally(() => this.pending.delete(range));
    }
  }, { eventHandlers: { paste(event) { return this.receive(event); }, drop(event) { return this.receive(event); } } }));
}
