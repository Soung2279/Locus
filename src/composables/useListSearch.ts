import { computed, nextTick, ref, watch, type Ref } from "vue";
import { isSearchScopeVisible, useSearchScope } from "./useSearchScope";

export function useListSearch<T>(options: {
  root: Ref<HTMLElement | null>;
  items: () => T[];
  text: (item: T) => string;
  reveal: (index: number) => void;
  enabled?: () => boolean;
}) {
  const visible = ref(false);
  const query = ref("");
  const position = ref(0);
  const bar = ref<{ focus(): void } | null>(null);
  let previousFocus: HTMLElement | null = null;
  const matches = computed(() => {
    const needle = query.value.toLocaleLowerCase();
    if (!visible.value || !needle) return [];
    return options.items().flatMap((item, index) => options.text(item).toLocaleLowerCase().includes(needle) ? [index] : []);
  });
  const currentIndex = computed(() => matches.value[position.value] ?? -1);
  const current = computed(() => matches.value.length ? position.value + 1 : 0);
  function reveal() { if (currentIndex.value >= 0) options.reveal(currentIndex.value); }
  async function open() {
    if (!visible.value) {
      const root = options.root.value;
      const active = root?.ownerDocument.activeElement as HTMLElement | null;
      previousFocus = root?.contains(active) ? active : root;
    }
    visible.value = true;
    await nextTick();
    bar.value?.focus();
    reveal();
  }
  function close() {
    visible.value = false;
    const target = previousFocus && isSearchScopeVisible(previousFocus) ? previousFocus : options.root.value;
    target?.focus({ preventScroll: true });
  }
  function move(delta: number) {
    if (!matches.value.length) return;
    position.value = (position.value + delta + matches.value.length) % matches.value.length;
    reveal();
  }
  watch(query, () => { position.value = 0; });
  watch(matches, () => {
    position.value = Math.min(position.value, Math.max(0, matches.value.length - 1));
    void nextTick(reveal);
  });
  useSearchScope(options.root, () => { void open(); }, { enabled: options.enabled });
  return { visible, query, bar, matches, currentIndex, current, close, move };
}
