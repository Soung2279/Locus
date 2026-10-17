// @vitest-environment jsdom
import { createApp, nextTick, ref, type App } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import WorkspaceFileTreeSource from "../components/explorer/WorkspaceFileTreeSource.vue";

const mocks = vi.hoisted(() => ({ asset: vi.fn() }));
vi.mock("../composables/useAssetState", () => ({ useAssetState: mocks.asset }));
vi.mock("../composables/useWorkspaceFileOrder", () => ({ useWorkspaceFileOrder: () => ({ order: ref({ revision: 0, placements: [] }) }) }));
vi.mock("../services/workspaceExplorer", () => ({ subscribeExplorerFileActions: vi.fn(async () => () => {}) }));
const apps: App[] = [];
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); mocks.asset.mockClear(); });

it.each([undefined, false, true])("uses the correct refresh activity when active is %s", async active => {
  mocks.asset.mockReturnValue({ explorerTree: ref([]), error: ref(""), isPathExpanded: () => false });
  const app = createApp(WorkspaceFileTreeSource, {
    workingDir: "F:/repo", workspaceRef: { checkoutId: "checkout" },
    ...(active === undefined ? {} : { active }),
  });
  apps.push(app); app.mount(document.createElement("div")); await nextTick();
  const props = mocks.asset.mock.calls[0]![0];
  expect(props.active).toBe(active ?? true);
  expect(props.watchWorkspaceFiles).toBe(true);
});
