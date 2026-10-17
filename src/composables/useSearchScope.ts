import { onMounted, onUnmounted, watch, type Ref } from "vue";
import { matchesShortcut, useKeyboardShortcuts } from "./useKeyboardShortcuts";

interface SearchScope {
  root: () => HTMLElement | null;
  open: () => void;
  enabled?: () => boolean;
  priority?: number;
}
interface GlobalSearchHandler {
  open: () => void;
  enabled: () => boolean;
}

// One router per DOM window, including workbenches hosted in auxiliary windows.
const routers = new WeakMap<Window, ReturnType<typeof createRouter>>();

export function isSearchScopeVisible(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true") return false;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === "none" || style?.visibility === "hidden") return false;
  }
  return true;
}

function eventElement(event: Event): HTMLElement | null {
  // Avoid instanceof checks: auxiliary-window elements belong to a different realm.
  return event.composedPath().find((item) => (item as Node).nodeType === 1) as HTMLElement | undefined ?? null;
}

function createRouter(owner: Window) {
  const scopes = new Set<SearchScope>();
  const globals = new Set<GlobalSearchHandler>();
  const { state } = useKeyboardShortcuts();
  let interaction: HTMLElement | null = null;

  function record(event: Event) { interaction = eventElement(event); }
  function resolve(target: HTMLElement | null): SearchScope | undefined {
    const available = [...scopes].filter((scope) => {
      const root = scope.root();
      return root && scope.enabled?.() !== false && isSearchScopeVisible(root);
    });
    for (let node = target; node; node = node.parentElement) {
      const direct = available.find((scope) => scope.root() === node);
      if (direct) return direct;
      if (node.hasAttribute("data-search-boundary")) {
        // Tab headers and document margins belong to the visible content in this pane.
        return available.filter((scope) => node!.contains(scope.root()))
          .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))[0];
      }
      if (node.matches('[role="dialog"], [aria-modal="true"]')) return;
    }
  }
  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const target = eventElement(event);
    if (target?.closest('[data-shortcut-recording="true"]')) return;
    const global = [...globals].find((handler) => handler.enabled());
    let open: (() => void) | undefined;
    if (matchesShortcut(event, state.globalSearch)) open = global?.open;
    else if (matchesShortcut(event, state.findInContext)) {
      // Clicking non-focusable content does not necessarily change activeElement.
      const current = interaction && isSearchScopeVisible(interaction) ? interaction : target;
      open = resolve(current)?.open ?? global?.open;
    }
    if (!open) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    open();
  }
  owner.addEventListener("pointerdown", record, true);
  owner.addEventListener("focusin", record, true);
  owner.addEventListener("keydown", keydown, true);
  return {
    scopes, globals,
    release() {
      if (scopes.size || globals.size) return;
      owner.removeEventListener("pointerdown", record, true);
      owner.removeEventListener("focusin", record, true);
      owner.removeEventListener("keydown", keydown, true);
      routers.delete(owner);
    },
  };
}

function routerFor(owner: Window) {
  let router = routers.get(owner);
  if (!router) { router = createRouter(owner); routers.set(owner, router); }
  return router;
}

export function registerSearchScope(owner: Window, scope: SearchScope): () => void {
  const router = routerFor(owner);
  router.scopes.add(scope);
  return () => { router.scopes.delete(scope); router.release(); };
}

export function useSearchScope(root: Ref<HTMLElement | null>, open: () => void, options: Pick<SearchScope, "enabled" | "priority"> = {}) {
  watch(root, (element, _, cleanup) => {
    const owner = element?.ownerDocument.defaultView;
    if (!owner) return;
    cleanup(registerSearchScope(owner, { root: () => root.value, open, ...options }));
  }, { flush: "post" });
}

export function useGlobalSearchShortcut(owner: Window, handler: GlobalSearchHandler) {
  let release: (() => void) | undefined;
  onMounted(() => {
    const router = routerFor(owner);
    router.globals.add(handler);
    release = () => { router.globals.delete(handler); router.release(); };
  });
  onUnmounted(() => release?.());
}
