<script setup lang="ts">
import { ref } from "vue";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { t } from "../../i18n";
import { useNotificationStore } from "../../stores/notification";
import { useProjectStore } from "../../stores/project";
import { checkViewOpenRequirements, normalizeViewError, viewDeleteEntry, viewExportPackage, viewRunInUnity } from "../../services/view";
import { isPluginView } from "./viewTreeActions";
import ViewConfigDialog from "./ViewConfigDialog.vue";
import type { ViewResourceAction, ViewResourceTarget } from "./viewResourceActions";
const emit = defineEmits<{ changed: [target: ViewResourceTarget] }>();
const notifications = useNotificationStore();
const project = useProjectStore();
const config = ref<ViewResourceTarget | null>(null);
const busy = ref(false);
async function run(action: ViewResourceAction, target: ViewResourceTarget) {
  if (busy.value) return;
  const { view, workspaceRef } = target;
  if (isPluginView(view) && ["rename", "export", "delete"].includes(action)) return;
  if (action === "configure" || action === "rename") {
    config.value = { view: { ...view }, workspaceRef: { ...workspaceRef } };
    return;
  }
  busy.value = true;
  try {
    if (action === "unity") {
      const error = await checkViewOpenRequirements(workspaceRef, view);
      if (error) throw error;
      await viewRunInUnity(workspaceRef, view.id);
    } else if (action === "export") {
      const path = await save({ defaultPath: `${view.id}.zip`, filters: [{ name: t("view.archive.filter"), extensions: ["zip"] }] });
      if (path) {
        const saved = await viewExportPackage(workspaceRef, { viewId: view.id, filePath: path });
        notifications.addNotice("success", t("view.export.exported", saved));
      }
    } else if (action === "reveal") {
      const path = /\.vue$/i.test(view.packageRoot) ? view.packageRoot.replace(/[\\/][^\\/]+$/, "") : view.packageRoot;
      await project.openDirInFileExplorer(path);
    } else if (action === "copy") {
      await navigator.clipboard.writeText(view.packageRelPath || view.displayPath);
      notifications.addNotice("success", t("knowledge.explorer.relativePathCopied"));
    } else if (action === "delete") {
      if (!await confirm(t("view.tree.deleteConfirmMessage", view.name), { title: t("common.confirmDelete"), kind: "warning", okLabel: t("common.delete"), cancelLabel: t("common.cancel") })) return;
      await viewDeleteEntry(workspaceRef, { relPath: view.displayPath });
      emit("changed", target);
    }
  } catch (cause) { notifications.addNotice("error", normalizeViewError(cause, { viewName: view.name }).message); }
  finally { busy.value = false; }
}
defineExpose({ run, busy });
</script>
<template>
  <ViewConfigDialog v-if="config" :view="config.view" :workspace-ref="config.workspaceRef" @close="config = null" @saved="emit('changed', { ...config, view: $event })" />
</template>
