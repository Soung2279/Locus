import { shallowRef } from "vue";
import { workspaceRelativeEntryPath } from "../components/explorer/workspaceFileMove";

const PREFIX = "locus:workspaceHiddenFiles:";
const pathsByCheckout = shallowRef<Record<string, string[]>>({});

function normalize(path: string): string | null {
  if (/^(?:[/\\]|[a-z]:)/i.test(path)) return null;
  return workspaceRelativeEntryPath("", path) || null;
}

function read(checkoutId: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFIX + checkoutId) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.flatMap(path => {
      const normalized = typeof path === "string" ? normalize(path) : null;
      return normalized ? [normalized] : [];
    }))] : [];
  } catch { return []; }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", event => {
    if (event.key === null) pathsByCheckout.value = {};
    else if (event.key.startsWith(PREFIX)) {
      const checkoutId = event.key.slice(PREFIX.length);
      pathsByCheckout.value = { ...pathsByCheckout.value, [checkoutId]: read(checkoutId) };
    }
  });
}

export function workspacePathIsHidden(path: string, hidden: readonly string[]): boolean {
  return hidden.some(parent => path === parent || path.startsWith(`${parent}/`));
}

/** Local display preferences, scoped exactly like the workspace navigation mode. */
export function useWorkspaceFileVisibility() {
  function paths(checkoutId: string): string[] {
    if (!pathsByCheckout.value[checkoutId]) {
      pathsByCheckout.value = { ...pathsByCheckout.value, [checkoutId]: read(checkoutId) };
    }
    return pathsByCheckout.value[checkoutId]!;
  }
  function save(checkoutId: string, paths: string[]) {
    const unique = [...new Set(paths)];
    // Report storage failures to the caller rather than pretending the preference was saved.
    localStorage.setItem(PREFIX + checkoutId, JSON.stringify(unique));
    pathsByCheckout.value = { ...pathsByCheckout.value, [checkoutId]: unique };
  }
  function setHidden(checkoutId: string, path: string, hidden: boolean) {
    const normalized = normalize(path);
    if (!checkoutId || !normalized) return;
    const current = read(checkoutId);
    save(checkoutId, hidden ? [...current, normalized] : current.filter(item => item !== normalized));
  }
  function remap(checkoutId: string, source: string, target: string | null) {
    const from = normalize(source), to = target === null ? null : normalize(target);
    if (!from || (target !== null && !to)) return;
    const current = read(checkoutId);
    if (!current.some(path => workspacePathIsHidden(path, [from]))) return;
    save(checkoutId, current.flatMap(path => workspacePathIsHidden(path, [from])
      ? to ? [to + path.slice(from.length)] : [] : [path]));
  }
  return { paths, setHidden, remap };
}
