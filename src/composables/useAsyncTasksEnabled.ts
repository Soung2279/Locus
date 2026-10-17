import { onScopeDispose, readonly, ref, type Ref } from "vue";
import { subscribeAsyncTasksEnabled } from "../services/asyncTasks";
import type { RuntimeUnsubscribe } from "../services/locusRuntime";
import { getAsyncTasksEnabled } from "../services/system";

// Chat surfaces are remounted on every workbench session switch. Keeping the
// setting in one shared ref lets a new surface render its final status row in
// the first frame instead of waiting for the listener and the settings IPC.
const enabled = ref(false);
const enabledView = readonly(enabled);
let consumers = 0;
let generation = 0;
let settingsRevision = 0;
let unsubscribe: RuntimeUnsubscribe | undefined;

async function connect(currentGeneration: number): Promise<void> {
  try {
    const release = await subscribeAsyncTasksEnabled((value) => {
      settingsRevision += 1;
      enabled.value = value;
    });
    if (currentGeneration !== generation) {
      release();
      return;
    }
    unsubscribe = release;
  } catch (cause) {
    console.error("Failed to subscribe to async task settings", cause);
  }
  // Subscribe first so a change emitted during the read is never lost.
  const revision = settingsRevision;
  try {
    const value = await getAsyncTasksEnabled();
    if (currentGeneration === generation && revision === settingsRevision) enabled.value = value;
  } catch (cause) {
    console.error("Failed to load async task settings", cause);
  }
}

function retain(): void {
  consumers += 1;
  if (consumers === 1) void connect(generation);
}

function release(): void {
  consumers = Math.max(0, consumers - 1);
  if (consumers > 0) return;
  // The last known value stays cached for the next surface; the next retain
  // revalidates it.
  generation += 1;
  unsubscribe?.();
  unsubscribe = undefined;
}

export function useAsyncTasksEnabled(): Readonly<Ref<boolean>> {
  retain();
  onScopeDispose(release);
  return enabledView;
}
