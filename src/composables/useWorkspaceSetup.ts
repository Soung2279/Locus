import { ref } from "vue";
import { inspectWorkspaceSetup, saveWorkspaceSetup, type WorkspaceSetup } from "../services/project";

interface SetupRequest {
  path: string;
  mode: "add" | "edit";
  setup: WorkspaceSetup;
  resolve: (saved: boolean) => void;
}

const request = ref<SetupRequest | null>(null);
const saving = ref(false);

export async function requestWorkspaceSetup(path: string, mode: "add" | "edit" = "add"): Promise<boolean> {
  if (request.value || saving.value) return false;
  const setup = await inspectWorkspaceSetup(path);
  if (request.value) return false;
  return new Promise(resolve => {
    request.value = { path, mode, setup: { ...setup, extraWorkdirs: setup.extraWorkdirs ?? [] }, resolve };
  });
}

export function useWorkspaceSetup() {
  function cancel() {
    if (saving.value) return;
    const current = request.value;
    request.value = null;
    current?.resolve(false);
  }
  async function save() {
    const current = request.value;
    if (!current || saving.value) return;
    saving.value = true;
    try {
      await saveWorkspaceSetup(current.path, { ...current.setup });
      request.value = null;
      current.resolve(true);
    } finally { saving.value = false; }
  }
  return { request, saving, cancel, save };
}
