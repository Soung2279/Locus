/** Raw WebView2 controllers do not have Tauri's native drop listener. */
export function installUnityNativeFileDrop(owner: Window, generation: string): () => void {
  const bridge = () => (owner as Window & { chrome?: { webview?: {
    postMessage(value: unknown): void;
    postMessageWithAdditionalObjects(value: unknown, files: File[]): void;
  } } }).chrome?.webview;
  let overAt = 0;
  let dragging = false;
  let disposed = false;
  const send = (phase: string, event?: DragEvent) => bridge()?.postMessage({
    type: "native-file-drag", generation, phase,
    x: event?.clientX ?? 0, y: event?.clientY ?? 0,
    count: event?.dataTransfer?.items.length ?? 0,
  });
  const over = (event: DragEvent) => {
    if (disposed) return;
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "copy";
    const now = performance.now();
    if (!dragging || now - overAt > 32) { send(dragging ? "over" : "enter", event); overAt = now; }
    dragging = true;
  };
  const leave = () => { if (dragging) send("leave"); dragging = false; };
  const outside = (event: DragEvent) => { if (event.relatedTarget === null) leave(); };
  const drop = (event: DragEvent) => {
    if (disposed) return;
    const files = Array.from(event.dataTransfer?.files ?? []).slice(0, 64);
    if (!files.length) return;
    event.preventDefault(); dragging = false;
    bridge()?.postMessageWithAdditionalObjects({ type: "native-file-drop", generation, x: event.clientX, y: event.clientY }, files);
  };
  owner.document.addEventListener("dragover", over, true);
  owner.document.addEventListener("drop", drop, true);
  owner.document.addEventListener("dragleave", outside, true);
  owner.document.addEventListener("dragend", leave);
  owner.addEventListener("blur", leave);
  return () => {
    leave();
    disposed = true;
    owner.document.removeEventListener("dragover", over, true);
    owner.document.removeEventListener("drop", drop, true);
    owner.document.removeEventListener("dragleave", outside, true);
    owner.document.removeEventListener("dragend", leave);
    owner.removeEventListener("blur", leave);
  };
}
