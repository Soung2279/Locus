// @vitest-environment jsdom
import { createApp, h, nextTick, reactive } from "vue";
import { icons } from "lucide";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorkbenchEditorTabs from "../components/workbench/WorkbenchEditorTabs.vue";
import { provideInternalDragController } from "../composables/useInternalDrag";
import { createWorkbenchEditorInput } from "../stores/workbench";
import type { WorkbenchEditorGroup } from "../types/workbench";
import { workbenchViewIconValue } from "../components/workbench/workbenchViewIcon";

vi.mock("../i18n", () => ({ t: (key: string) => key }));
vi.mock("../stores/chat", () => ({ useChatStore: () => ({ streamingSessionIds: new Set(), sessions: [] }) }));
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach((cleanup) => cleanup()); document.body.replaceChildren(); });

describe("Workbench View tab icons", () => {
  it("reacts to first async metadata arrival and subsequent Lucide, SVG and default changes", async () => {
    const editor = createWorkbenchEditorInput({ kind: "view", projectId: "project", viewId: "battle" }, "Battle");
    const group: WorkbenchEditorGroup = { paneId: "pane", tabs: [editor], activeEditorId: editor.editorId };
    const loadedIcons = reactive<Record<string, string | null>>({});
    const host = document.createElement("div"); document.body.append(host);
    const app = createApp({ setup() {
      const controller = provideInternalDragController();
      cleanups.push(() => controller.dispose());
      return () => h(WorkbenchEditorTabs, { windowId: "main", group, showSingleTab: true,
        viewIcon: (item) => workbenchViewIconValue(item, loadedIcons, {}),
      });
    } });
    app.mount(host); cleanups.push(() => app.unmount());
    const tab = host.querySelector(`[data-workbench-tab-id="${editor.editorId}"]`)!;
    expect(tab.querySelector("polyline")).toBeNull();
    loadedIcons[editor.editorId] = "Swords";
    await nextTick();
    expect(tab.querySelector("polyline")?.getAttribute("points")).toBe(icons.Swords[0]![1].points);
    loadedIcons[editor.editorId] = '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="9"/></svg>';
    await nextTick();
    expect(tab.querySelector("svg svg")?.getAttribute("viewBox")).toBe("0 0 32 32");
    expect(tab.querySelector("circle")?.getAttribute("r")).toBe("9");
    loadedIcons[editor.editorId] = null;
    await nextTick();
    expect(tab.querySelector("svg svg")).toBeNull();
    expect(tab.querySelector("path")?.getAttribute("d")).toBe(icons.View.find(([tag]) => tag === "path")?.[1].d);
  });
});
