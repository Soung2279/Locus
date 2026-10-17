<script setup lang="ts">
import { reactive, ref } from "vue";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { t } from "../../i18n";
import { useNotificationStore } from "../../stores/notification";
import { useWorkspaceExplorerStore } from "../../stores/workspaceExplorer";
import { normalizeAppError } from "../../services/errors";
import { explorerFileAction } from "../../services/workspaceExplorer";
import { deleteSkillPackage, exportSkillPackage, knowledgeDelete, knowledgeMove, knowledgeRevealTarget } from "../../services/knowledge";
import { showInFolder } from "../../services/unity";
import { isSkillPackageRootDocument, skillPackageIdForDocument } from "../../composables/useKnowledgeState";
import { useExplorerPathDisplay } from "../../composables/useExplorerPathDisplay";
import { knowledgeResourceManagedHint } from "../knowledge/knowledgeResourceActions";
import { resourceName, resourceRelativePath, validResourceName, type ExplorerResourceAction, type ExplorerResourceRename, type ExplorerResourceTarget } from "./explorerResourceActions";
import type { FileHistoryTarget } from "../../services/fileHistory";

const emit = defineEmits<{
  changed: [target: ExplorerResourceTarget, newPath: string | null];
  history: [target: FileHistoryTarget];
}>();
const notificationStore = useNotificationStore();
const explorerStore = useWorkspaceExplorerStore();
const { movePathPreference } = useExplorerPathDisplay();
const draft = ref<ExplorerResourceRename | null>(null);
function cancel(current = draft.value) {
  if (draft.value === current && !current?.busy) draft.value = null;
}

async function mutate(target: ExplorerResourceTarget, name: string | null) {
  const document = target.document;
  if (document && knowledgeResourceManagedHint(document)) return;
  let nextPath: string | null = null;
  if (document) {
    if (!target.workspaceRef) throw new Error(t("development.workspaceUnavailable"));
    if (name !== null) {
      nextPath = document.path.replace(/[^/\\]+$/, name);
      await knowledgeMove({ kind: "document", type: document.type, path: document.path, newPath: nextPath }, target.workspaceRef);
    } else if (isSkillPackageRootDocument(document)) {
      await deleteSkillPackage(skillPackageIdForDocument(document)!, target.workspaceRef);
    } else {
      await knowledgeDelete({ kind: "document", type: document.type, path: document.path }, target.workspaceRef);
    }
  } else {
    const workspaceRef = target.mounted ? null : target.workspaceRef;
    // Scoped file actions require paths relative to the captured checkout root.
    // Project-authorized mounts keep their absolute paths.
    const path = workspaceRef ? resourceRelativePath(target) : target.path;
    nextPath = await explorerFileAction(target.projectId, path, name, workspaceRef);
    if (nextPath) movePathPreference(target.path, nextPath);
  }
  emit("changed", target, nextPath);
  // A refresh failure must not present an already completed rename as a failed
  // mutation or invite a retry against the old path.
  try {
    if (document) await explorerStore.refreshProjectKnowledge(target.projectId);
    else await explorerStore.loadProject(target.projectId, true);
    const mounts = explorerStore.snapshots[target.projectId]?.nodes.filter((node) => node.nodeKind === "folder" && node.sourcePath) ?? [];
    const results = await Promise.allSettled(mounts.map((node) => explorerStore.loadMount(target.projectId, node.nodeId, true)));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } catch (error) { notificationStore.addNotice("warning", normalizeAppError(error).message); }
}

async function commit(current: ExplorerResourceRename) {
  if (draft.value !== current || current.busy) return;
  const name = current.name.trim();
  if (!validResourceName(name)) {
    current.error = t("development.invalidFileName");
    notificationStore.addNotice("error", current.error);
    return;
  }
  if (name === resourceName(current.target)) { draft.value = null; return; }
  current.busy = true;
  current.error = "";
  try { await mutate(current.target, name); if (draft.value === current) draft.value = null; }
  catch (error) {
    current.error = normalizeAppError(error).message;
    notificationStore.addNotice("error", current.error);
  }
  finally { current.busy = false; }
}

async function run(action: ExplorerResourceAction, target: ExplorerResourceTarget, rowKey = target.path) {
  if ((action === "rename" || action === "delete") && target.document && knowledgeResourceManagedHint(target.document)) return;
  try {
    if (action === "history") {
      const workspaceRef = target.mounted ? null : target.workspaceRef ?? null;
      emit("history", {
        projectId: target.projectId,
        path: target.document ? `Locus/knowledge/${resourceRelativePath(target)}` : workspaceRef ? resourceRelativePath(target) : target.path,
        workspaceRef: workspaceRef ? { ...workspaceRef } : null,
      });
    } else if (action === "rename") {
      if (draft.value?.busy || target.isDirectory || (target.document && isSkillPackageRootDocument(target.document))) return;
      const current: ExplorerResourceRename = reactive({
        key: rowKey, target, name: resourceName(target), busy: false, error: "",
        submit: () => commit(current), cancel: () => cancel(current),
      });
      draft.value = current;
    } else if (action === "delete") {
      const packageRoot = target.document && isSkillPackageRootDocument(target.document);
      const approved = await confirm(t(packageRoot ? "knowledge.explorer.deletePackageConfirm" : "knowledge.explorer.deleteDocumentConfirm", resourceName(target)), {
        title: t("common.confirmDelete"), kind: "warning", okLabel: t("common.delete"), cancelLabel: t("common.cancel"),
      });
      if (approved) await mutate(target, null);
    } else if (action === "copy") {
      await navigator.clipboard.writeText(resourceRelativePath(target));
      notificationStore.addNotice("success", t("knowledge.explorer.relativePathCopied"));
    } else if (action === "reveal" && target.workspaceRef) {
      if (target.document) await knowledgeRevealTarget({ kind: "document", docType: target.document.type, path: target.document.path }, target.workspaceRef);
      else await showInFolder(target.workspaceRef, target.path);
    } else if (action === "export" && target.document && target.workspaceRef) {
      const packageId = skillPackageIdForDocument(target.document);
      if (!packageId || target.document.externalSource?.locator?.startsWith("external://")) return;
      const path = await save({ defaultPath: `${packageId.replace(/[/\\]/g, "-")}.zip`, filters: [{ name: t("knowledge.skillPackage.archiveFilter"), extensions: ["zip"] }] });
      if (path) await exportSkillPackage(packageId, path, target.workspaceRef);
    }
  } catch (error) { notificationStore.addNotice("error", normalizeAppError(error).message); }
}
defineExpose({ run, draft, cancel });
</script>

<template></template>
