// @vitest-environment jsdom
import { createApp, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorkbenchEditorTabs from "../components/workbench/WorkbenchEditorTabs.vue";
import { provideInternalDragController } from "../composables/useInternalDrag";
import { createWorkbenchEditorInput } from "../stores/workbench";
import type { WorkbenchEditorGroup } from "../types/workbench";

vi.mock("../i18n", () => ({ t: (key: string) => key }));
vi.mock("../stores/chat", () => ({
  useChatStore: () => ({ streamingSessionIds: new Set(), sessions: [] }),
}));

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
  document.body.replaceChildren();
});

async function openMenu(tabCount: number, targetIndex: number) {
  const tabs = Array.from({ length: tabCount }, (_, index) => createWorkbenchEditorInput(
    { kind: "newSession", projectId: `project-${index}` }, `Tab ${index}`,
  ));
  const group: WorkbenchEditorGroup = {
    paneId: "pane", tabs, activeEditorId: tabs[0]!.editorId,
  };
  const activate = vi.fn();
  const closeMany = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup() {
    const controller = provideInternalDragController();
    cleanups.push(() => controller.dispose());
    return () => h(WorkbenchEditorTabs, {
      windowId: "main", group, showSingleTab: true,
      onActivate: activate, "onClose-many": closeMany,
    });
  } });
  app.mount(host);
  cleanups.push(() => app.unmount());
  await nextTick();
  host.querySelector(`[data-workbench-tab-id="${tabs[targetIndex]!.editorId}"]`)!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 30 }));
  await nextTick();
  const menu = document.querySelector('[role="menu"]')!;
  const others = Array.from(menu.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.trim() === "workbench.tabs.closeOthers")!;
  return { tabs, menu, others, activate, closeMany };
}

describe("workbench tab context menu", () => {
  it("keeps and activates the context tab before closing other tabs", async () => {
    const { tabs, others, activate, closeMany } = await openMenu(3, 1);
    expect(others.disabled).toBe(false);
    others.click();
    await nextTick();
    expect(activate).toHaveBeenCalledExactlyOnceWith(tabs[1]!.editorId);
    expect(closeMany).toHaveBeenCalledExactlyOnceWith([tabs[0]!.editorId, tabs[2]!.editorId]);
    expect(activate.mock.invocationCallOrder[0]).toBeLessThan(closeMany.mock.invocationCallOrder[0]!);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("disables Close Others when there is only one tab", async () => {
    const { others, activate, closeMany } = await openMenu(1, 0);
    expect(others.disabled).toBe(true);
    others.click();
    expect(activate).not.toHaveBeenCalled();
    expect(closeMany).not.toHaveBeenCalled();
  });
});
