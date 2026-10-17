// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileHistoryPanel from "../components/explorer/FileHistoryPanel.vue";
import WorkbenchSecondarySidebar from "../components/workbench/WorkbenchSecondarySidebar.vue";
import ResourceFileMenuItems from "../components/explorer/ResourceFileMenuItems.vue";
import { supportsFileHistory } from "../components/explorer/explorerResourceActions";
import type { FileHistoryPreview, FileHistoryTarget } from "../services/fileHistory";
import { t } from "../i18n";

const mocks = vi.hoisted(() => ({ list: vi.fn(), preview: vi.fn(), restore: vi.fn(), confirm: vi.fn(), notice: vi.fn() }));
vi.mock("../services/fileHistory", () => ({ fileHistory: mocks.list, fileHistoryPreview: mocks.preview, fileHistoryRestore: mocks.restore }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: mocks.confirm }));
vi.mock("../stores/notification", () => ({ useNotificationStore: () => ({ addNotice: mocks.notice }) }));
vi.mock("../components/explorer/FileHistoryPreview.vue", () => ({ default: {
  props: ["preview"], setup: (props: { preview: FileHistoryPreview }) => () => h("div", { class: "preview-result" }, props.preview.file.text),
} }));
const target: FileHistoryTarget = { projectId: "project", path: "docs/test.md", workspaceRef: { checkoutId: "checkout", expectedGeneration: 3 } };
const commits = ["a".repeat(40), "b".repeat(40)];
const apps: App[] = [];
const versions = commits.map((commit, i) => ({ commit, author: `Author ${i}`, email: `author${i}@example.invalid`,
  modifiedAt: "2026-10-09T12:00:00+08:00", subject: `Change ${i}`, path: target.path, blob: `${i}`.repeat(40) }));
function preview(text: string): FileHistoryPreview {
  return { contentHash: text, asset: null, csvView: null, file: {
    path: target.path, name: "test.md", extension: "md", text, size: text.length, kind: "text", mimeType: "text/plain",
    truncated: false, editable: false, revision: { exists: true, size: text.length, modifiedAtNanos: "1", key: "1" },
  } };
}
async function flush() { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick(); } }
async function mountPanel() {
  const host = document.createElement("div"); document.body.appendChild(host);
  const sidebar = ref<HTMLElement | null>(null);
  const toolbar = ref<HTMLElement | null>(null);
  const visible = ref(true);
  const activate = vi.fn(async () => {});
  const app = createApp(() => h("div", [
    visible.value ? h(WorkbenchSecondarySidebar, { title: t("fileHistory.title"), onClose: () => { visible.value = false; } }, {
      default: ({ toolbarTarget }: { toolbarTarget: HTMLElement | null }) => h("div", {
        ref: (value: unknown) => { sidebar.value = value as HTMLElement | null; toolbar.value = value ? toolbarTarget : null; },
      }),
    }) : null,
    h("main", h(FileHistoryPanel, { target, sidebarTarget: sidebar.value, sidebarToolbarTarget: toolbar.value, activateEditor: activate })),
  ]));
  apps.push(app); app.mount(host); await flush();
  return { visible, host, activate };
}
function button(label: string): HTMLButtonElement {
  label = t(label);
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.title === label);
  expect(result, label).toBeDefined(); return result!;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ versions, currentHash: "current", currentModifiedAt: "1791518400000000000", isRepository: true });
  mocks.preview.mockImplementation(async (_: unknown, commit: string | null) => preview(commit ?? "current"));
  mocks.restore.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(true);
});
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); document.body.innerHTML = ""; });

describe("file history workbench", () => {
  it("shows the current version, commit metadata, and previews without restoring", async () => {
    await mountPanel();
    expect(document.querySelectorAll(".history-version")).toHaveLength(3);
    expect(document.querySelector(".preview-result")?.textContent).toBe("current");
    expect(document.querySelector('[title="author0@example.invalid"]')?.textContent).toBe("Author 0");
    expect(document.querySelector("code")?.textContent).toBe("aaaaaaaa");
    expect(button("fileHistory.restore").disabled).toBe(true);
    (document.querySelectorAll<HTMLButtonElement>(".history-version")[1]!).click(); await flush();
    expect(mocks.preview).toHaveBeenLastCalledWith(target, commits[0]);
    expect(document.querySelector(".preview-result")?.textContent).toBe(commits[0]);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("ignores a late preview after another version is selected", async () => {
    await mountPanel();
    let resolve!: (value: FileHistoryPreview) => void;
    mocks.preview.mockImplementationOnce(() => new Promise<FileHistoryPreview>(done => { resolve = done; }));
    document.querySelectorAll<HTMLButtonElement>(".history-version")[1]!.click(); await flush();
    document.querySelectorAll<HTMLButtonElement>(".history-version")[2]!.click(); await flush();
    resolve(preview("outdated response")); await flush();
    expect(document.querySelector(".preview-result")?.textContent).toBe(commits[1]);
    expect(document.querySelector('[aria-current="true"] code')?.textContent).toBe("bbbbbbbb");
  });

  it("restores only after confirmation with the captured checkout and current hash", async () => {
    await mountPanel();
    document.querySelectorAll<HTMLButtonElement>(".history-version")[1]!.click(); await flush();
    mocks.confirm.mockResolvedValueOnce(false);
    button("fileHistory.restore").click(); await flush();
    expect(mocks.restore).not.toHaveBeenCalled();
    button("fileHistory.restore").click(); await flush();
    expect(mocks.restore).toHaveBeenCalledWith(target, commits[0], "current");
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".preview-result")?.textContent).toBe("current");
    expect(mocks.notice).toHaveBeenCalledWith("success", t("fileHistory.restored"));
  });

  it("keeps the latest selected version when focusing its tab completes out of order", async () => {
    const { activate } = await mountPanel();
    let focused!: () => void;
    activate.mockImplementationOnce(() => new Promise<void>(resolve => { focused = resolve; }));
    document.querySelectorAll<HTMLButtonElement>(".history-version")[1]!.click(); await flush();
    document.querySelectorAll<HTMLButtonElement>(".history-version")[2]!.click(); await flush();
    focused(); await flush();
    expect(document.querySelector(".preview-result")?.textContent).toBe(commits[1]);
    expect(mocks.preview).not.toHaveBeenCalledWith(target, commits[0]);
  });

  it("keeps failures visible and permits refreshing a stale working file", async () => {
    await mountPanel();
    document.querySelectorAll<HTMLButtonElement>(".history-version")[1]!.click(); await flush();
    mocks.restore.mockRejectedValueOnce(new Error("Changed on disk"));
    button("fileHistory.restore").click(); await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Changed on disk");
    expect(mocks.notice).not.toHaveBeenCalled();
    button("common.refresh").click(); await flush();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("disables restore when selected content already matches the current file", async () => {
    await mountPanel();
    mocks.preview.mockResolvedValueOnce(preview("current"));
    document.querySelectorAll<HTMLButtonElement>(".history-version")[1]!.click(); await flush();
    expect(button("fileHistory.restore").disabled).toBe(true);
  });

  it("keeps current-file preview available outside Git", async () => {
    mocks.list.mockResolvedValue({ versions: [], currentHash: "current", currentModifiedAt: "1", isRepository: false });
    await mountPanel();
    expect(document.body.textContent).toContain(t("fileHistory.noRepository"));
    expect(document.querySelector(".preview-result")?.textContent).toBe("current");
  });

  it("uses the secondary column and keeps the preview when the column closes", async () => {
    const { visible, host, activate } = await mountPanel();
    expect(document.querySelector("dialog")).toBeNull();
    expect(host.querySelector("aside .history-list")).not.toBeNull();
    expect(host.querySelector("main .history-list")).toBeNull();
    expect(host.querySelector(".secondary-sidebar-actions .history-icon")).not.toBeNull();
    document.querySelectorAll<HTMLButtonElement>(".history-version")[1]!.click(); await flush();
    expect(activate).toHaveBeenCalledOnce();
    button("common.close").click(); await flush();
    expect(host.querySelector("aside")).toBeNull();
    expect(host.querySelector("main .preview-result")?.textContent).toBe(commits[0]);
    visible.value = true; await flush();
    expect(host.querySelector('aside [aria-current="true"] code')?.textContent).toBe("aaaaaaaa");
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
});

describe("file history menu", () => {
  it("offers history for workspace and mounted files and excludes directories", async () => {
    const file = { projectId: target.projectId, path: target.path, root: "F:/Project", workspaceRef: target.workspaceRef };
    expect(supportsFileHistory(file)).toBe(true);
    expect(supportsFileHistory({ ...file, mounted: true })).toBe(true);
    expect(supportsFileHistory({ ...file, isDirectory: true })).toBe(false);
    const action = vi.fn();
    const host = document.createElement("div"); document.body.appendChild(host);
    const app = createApp(ResourceFileMenuItems, { target: file, onAction: action }); apps.push(app); app.mount(host);
    button("fileHistory.menu").click(); await flush();
    expect(action).toHaveBeenCalledWith("history");
  });
});
