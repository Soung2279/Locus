import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";
import { commitUnityEmbedAssetDrop, subscribeUnityEmbedAssetDrop, subscribeUnityEmbedAssetDragState } from "../../services/unity";
import { useWindowSurface } from "../../composables/useWindowSurface";
import { useOptionalViewContext } from "../view/viewExecutionScope";
import { useWorkspaceContextStore } from "../../stores/workspaceContext";

// Native broadcasts have no position. Only the list that claimed the DOM drop
// may consume the subsequent payload; another list must never write it too.
export function useUnityPropertyListDrop(options: {
  root: Ref<HTMLElement | null>; enabled: () => boolean; stateKey: () => string;
  count: () => number; insert: (index: number, paths: string[]) => void; error: (error: unknown) => void;
}) {
  const { ownerWindow } = useWindowSurface();
  const context = useOptionalViewContext();
  const hovering = ref(false), nativePaths = ref<string[]>([]);
  let requested: { key: string; index: number } | null = null;
  let timer = 0;
  const enabled = computed(options.enabled);
  const paths = (values: string[]) => values.map(value => value.trim().replace(/\\/g, "/")).filter(value => /^(Assets|Packages)\//.test(value));
  const workspace = () => context?.workspaceRef ?? useWorkspaceContextStore().focusedWorkspaceRef;
  function clear() { hovering.value = false; requested = null; nativePaths.value = []; if (timer) ownerWindow.clearTimeout(timer); timer = 0; }
  watch([enabled, options.stateKey], ([active], _previous, onCleanup) => {
    clear(); if (!active) return;
    let disposed = false;
    const releases: (() => void)[] = [];
    const keep = (release: () => void) => disposed ? release() : releases.push(release);
    void subscribeUnityEmbedAssetDragState(payload => { nativePaths.value = payload.hasRefs ? paths(payload.refs.filter(ref => ref.kind === "asset").map(ref => ref.path)) : []; }).then(keep).catch(options.error);
    void subscribeUnityEmbedAssetDrop(payload => {
      const claim = requested;
      if (!claim || claim.key !== options.stateKey() || !options.enabled()) return;
      const target = workspace();
      if (payload.workspaceRef && (!target || payload.workspaceRef.checkoutId !== target.checkoutId || payload.workspaceRef.expectedGeneration !== target.expectedGeneration)) { clear(); return; }
      const values = paths(payload.refs.filter(ref => ref.kind === "asset").map(ref => ref.path));
      clear(); if (values.length) options.insert(claim.index, values);
    }).then(keep).catch(options.error);
    onCleanup(() => { disposed = true; releases.forEach(release => release()); clear(); });
  }, { immediate: true });
  onBeforeUnmount(clear);
  function accepts(event: DragEvent) {
    const target = event.target as HTMLElement;
    if (!enabled.value || target.closest(".unity-property-list") !== options.root.value || target.closest(".unity-property-editor")) return false;
    const types = [...(event.dataTransfer?.types ?? [])];
    return nativePaths.value.length > 0 || types.includes("text/plain") || types.includes("Files");
  }
  function dragover(event: DragEvent) {
    if (!accepts(event)) return;
    event.preventDefault(); event.stopPropagation(); hovering.value = true;
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }
  function dragleave(event: DragEvent) { if (!options.root.value?.contains(event.relatedTarget as Node | null)) hovering.value = false; }
  function drop(event: DragEvent) {
    if (!accepts(event)) return;
    event.preventDefault(); event.stopPropagation(); hovering.value = false;
    const row = (event.target as HTMLElement).closest<HTMLElement>(".array-item");
    const index = row ? Number(row.dataset.arraySourceIndex) + (event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 ? 1 : 0) : options.count();
    const values = paths((event.dataTransfer?.getData("text/plain") ?? "").split(/\r?\n/));
    if (values.length) { options.insert(index, values); return; }
    requested = { key: options.stateKey(), index };
    timer = ownerWindow.setTimeout(clear, 1500);
    void commitUnityEmbedAssetDrop(workspace()).catch(error => { clear(); options.error(error); });
  }
  return { hovering, dragover, dragleave, drop };
}
