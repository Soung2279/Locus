// Shared Workbench windows contain DOM owned by the opener's Vue runtime.
// Reloading their about:blank document destroys that DOM without bootstrapping
// an application. Refresh the active editor through its host instead.
export function installSharedWorkbenchWindowRefresh(
  ownerWindow: Window,
  refresh: () => Promise<void>,
): () => void {
  let pending = false;
  let disposed = false;
  const handleKeydown = (event: KeyboardEvent) => {
    const refreshKey = !event.altKey && (
      (event.key === "F5" && !event.metaKey)
      || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r")
    );
    if (!refreshKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat || pending) return;
    pending = true;
    void Promise.resolve().then(() => { if (!disposed) return refresh(); }).catch((error) => {
      console.warn("[workbench-window] failed to refresh active View", error);
    }).finally(() => { pending = false; });
  };
  ownerWindow.addEventListener("keydown", handleKeydown, true);
  return () => {
    disposed = true;
    ownerWindow.removeEventListener("keydown", handleKeydown, true);
  };
}
