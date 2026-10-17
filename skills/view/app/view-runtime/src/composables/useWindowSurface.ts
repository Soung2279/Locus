import { inject, provide, type InjectionKey } from "vue";

interface WindowSurface { window: Window; kind: "desktop" | "unity"; }
const windowSurfaceKey: InjectionKey<WindowSurface> = Symbol("LocusWindowSurface");

/** DOM ownership follows the displayed document even when Vue runs in its opener. */
export function provideWindowSurface(ownerWindow: Window, kind: WindowSurface["kind"] = "desktop"): void {
  provide(windowSurfaceKey, { window: ownerWindow, kind });
}
export function useWindowSurface() {
  const surface = inject(windowSurfaceKey, null);
  const ownerWindow = surface?.window ?? window;
  return { ownerWindow, ownerDocument: ownerWindow.document, unityEmbedded: surface?.kind === "unity" };
}
