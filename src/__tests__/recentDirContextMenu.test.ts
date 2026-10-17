import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cwd = process.cwd();

function read(relPath: string) {
  return readFileSync(resolve(cwd, relPath), "utf8");
}

describe("checkout context menu", () => {
  it("moves workspace actions from the title bar into Collaboration checkout nodes", () => {
    const app = read("src/App.vue");
    const workbench = read("src/components/workbench/DevelopmentWorkbench.vue");
    const projectStore = read("src/stores/project.ts");
    const projectService = read("src/services/project.ts");
    const rustWorkspace = read("src-tauri/src/commands/workspace.rs");
    const rustApp = read("src-tauri/src/lib.rs");
    expect(app).not.toContain("recentDirContextMenu");
    expect(app).not.toContain("workspace-selector");
    expect(workbench).toContain('item.meta.kind === "checkout"');
    expect(workbench).toContain("copyCheckoutMcpArtifact");
    expect(workbench).toContain("openCheckoutInFileExplorer");
    expect(workbench).toContain("configureCheckoutWorkspace");
    expect(workbench).toContain('t("common.openInFileExplorer")');
    expect(workbench).toContain('t("app.dir.copyMcpEndpoint")');

    expect(projectStore).toContain("async function openDirInFileExplorer(path: string)");
    expect(projectService).toContain('ipcInvoke<void>("open_dir_in_file_explorer"');

    expect(rustWorkspace).toContain("pub async fn open_dir_in_file_explorer");
    expect(rustApp).toContain("commands::open_dir_in_file_explorer");
  });

  it("configures the right-clicked workspace without changing the focused workspace", () => {
    const workbench = read("src/components/workbench/DevelopmentWorkbench.vue");
    const selector = workbench.slice(workbench.indexOf('v-if="workspaceMenu"'), workbench.indexOf('v-if="workspaceMenu && recentWorkspaceContextMenu"'));
    const itemMenu = workbench.slice(workbench.indexOf('v-if="workspaceMenu && recentWorkspaceContextMenu"'), workbench.indexOf('<ExplorerResourceActions ref="resourceActions"'));
    expect(selector).not.toContain('workspace.setup.title');
    expect(selector).not.toContain('app.dir.configureExtraWorkdirs');
    expect(selector).toContain('@contextmenu.prevent.stop="openRecentWorkspaceContextMenu(path, $event)"');
    expect(itemMenu).toContain('@click="configureRecentWorkspace"');
    expect(itemMenu).toContain('workspace.setup.title');
    const handler = workbench.slice(workbench.indexOf('async function configureRecentWorkspace()'), workbench.indexOf('async function openRecentWorkspaceInNewWindow()'));
    expect(handler).toContain('recentWorkspaceContextMenu.value?.path');
    expect(handler).toContain('configureWorkspace(path)');
    const configure = workbench.slice(workbench.indexOf('async function configureWorkspace(path:'), workbench.indexOf('function setWorkspaceMode('));
    expect(configure).toContain('requestWorkspaceSetup(path, "edit")');
    expect(configure).not.toContain('openAndFocus');
    expect(configure).not.toContain('focusedCheckout');
  });
});
