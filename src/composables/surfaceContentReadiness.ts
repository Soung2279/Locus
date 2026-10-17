import { inject, provide, readonly, ref, type InjectionKey, type Ref } from "vue";

/**
 * Lets content rendered inside a surface hold its presentation while a value
 * that changes the layout is still resolving, so the surface's first visible
 * frame is already final. Content outside such a surface renders as before.
 */
export interface SurfaceContentReadiness {
  readonly pending: Readonly<Ref<number>>;
  hold(): () => void;
}

const SURFACE_CONTENT_READINESS: InjectionKey<SurfaceContentReadiness> = Symbol("surface-content-readiness");

export function provideSurfaceContentReadiness(): SurfaceContentReadiness {
  const pending = ref(0);
  const readiness: SurfaceContentReadiness = {
    pending: readonly(pending),
    hold() {
      pending.value += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pending.value -= 1;
      };
    },
  };
  provide(SURFACE_CONTENT_READINESS, readiness);
  return readiness;
}

export function useSurfaceContentReadiness(): SurfaceContentReadiness | null {
  return inject(SURFACE_CONTENT_READINESS, null);
}
