// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import ts from "typescript";
import { nextTick, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkbenchEditorInput, useWorkbenchStore, workbenchResourceKey } from "../stores/workbench";
import type { WorkbenchResourceRef } from "../types/workbench";
import type { SessionSummary } from "../types";

// Exercise the production selection/replacement/draft handlers with the real tab store.
const source = readFileSync("src/components/workbench/DevelopmentWorkbench.vue", "utf8")
  .split('<script setup lang="ts">')[1]!.split("</script>")[0]!;
const parsed = ts.createSourceFile("workbench.ts", source, ts.ScriptTarget.Latest, true);
const names = ["handleWorkbenchSessionSelected", "replaceFocusedWorkbenchResource",
  "preserveReplacedWorkspaceSessionDraft", "restoreReplacedWorkspaceSessionDraft", "userMessageDraftHasContent"];
const handlers = parsed.statements.filter(statement => ts.isFunctionDeclaration(statement)
  && !!statement.name && names.includes(statement.name.text)).map(statement => statement.getText(parsed)).join("\n");
const code = ts.transpileModule(handlers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

function fixture() {
  const store = useWorkbenchStore();
  const state = store.ensureWindow("main");
  const sessions: SessionSummary[] = ["first", "second"].map(id => ({
    id, title: `${id} title`, sessionType: "chat", projectId: "project", updatedAt: 1,
    defaultCheckoutId: "checkout",
  }));
  const editor = (id: string) => createWorkbenchEditorInput(
    { kind: "session", projectId: "project", sessionId: id }, `${id} title`,
    { checkoutBinding: { checkoutId: "checkout" }, preview: false, pinned: true },
  );
  const first = store.openEditor("main", editor("first"));
  const second = store.openEditor("main", editor("second"));
  const otherPane = store.splitPane("main", "main", "right", editor("second"))!;
  const draft = {
    text: "Unsent message", images: [{ id: "image" }], assetRefs: [], localFiles: [], consoleTexts: [],
    intent: { mode: null, skills: [] },
  };
  const sessionEditorRefs = new Map<string, { exportTransferSnapshot: () => unknown; applyDraftPrefill: ReturnType<typeof vi.fn> }>();
  sessionEditorRefs.set(first.editorId, { exportTransferSnapshot: () => ({ composerDraft: draft }), applyDraftPrefill: vi.fn() });
  const open = vi.fn();
  const notice = vi.fn();
  const drafts = new Map();
  const props: { fixedWorkspaceRef?: { checkoutId: string } } = {};
  const dependencies = {
    props, workbenchWindow: ref(state), workbenchStore: store, WORKBENCH_WINDOW_ID: "main",
    sessionsForProject: (projectId: string) => sessions.filter(session => session.projectId === projectId),
    explorerStore: { resources: { project: { sessions } } },
    createEditorForResource(resource: WorkbenchResourceRef, options: { title: string; checkoutId: string }) {
      const result = createWorkbenchEditorInput(resource, options.title, {
        checkoutBinding: { checkoutId: options.checkoutId }, preview: false, pinned: true,
      });
      sessionEditorRefs.set(result.editorId, { exportTransferSnapshot: () => null, applyDraftPrefill: vi.fn() });
      return result;
    },
    editorForPane: () => undefined,
    focusWorkbenchEditor: async (paneId: string, editorId: string) => store.activateEditor("main", paneId, editorId),
    openWorkbenchResource: open,
    activeResource: ref(null),
    replacedWorkspaceSessionDrafts: drafts,
    sessionEditorRefs, workbenchResourceKey, nextTick,
    notificationStore: { addNotice: notice }, normalizeAppError: (error: unknown) => ({ message: String(error) }),
    t: (key: string) => key,
  };
  const select = new Function(...Object.keys(dependencies), `${code}\nreturn handleWorkbenchSessionSelected;`)(...Object.values(dependencies)) as
    (paneId: string, payload: { editorId: string; sessionId: string }) => Promise<void>;
  return { state, first, second, otherPane, draft, drafts, sessionEditorRefs, open, notice, props, select };
}

describe("composer session selection within its tab", () => {
  it("replaces only the originating tab even with multiple tabs and the target open in a different focused pane", async () => {
    const view = fixture();
    const otherBefore = JSON.stringify(view.state.groups[view.otherPane]);
    await view.select("main", { editorId: view.first.editorId, sessionId: "second" });
    const tabs = view.state.groups.main!.tabs;
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.resource).toEqual(view.second.resource);
    expect(tabs[0]!.title).toBe("second title");
    expect(tabs[1]!.editorId).toBe(view.second.editorId);
    expect(JSON.stringify(view.state.groups[view.otherPane])).toBe(otherBefore);
    expect(view.state.groups.main!.activeEditorId).toBe(tabs[0]!.editorId);
    expect(view.state.focusedPaneId).toBe("main");
    expect(view.open).not.toHaveBeenCalled();
    expect(view.notice).not.toHaveBeenCalled();
  });

  it("preserves an unsent draft and its attachments and restores them when returning", async () => {
    const view = fixture();
    await view.select("main", { editorId: view.first.editorId, sessionId: "second" });
    expect(view.drafts.get(workbenchResourceKey(view.first.resource))).toEqual(view.draft);
    const current = view.state.groups.main!.tabs[0]!;
    await view.select("main", { editorId: current.editorId, sessionId: "first" });
    const restored = view.state.groups.main!.tabs[0]!;
    expect(view.sessionEditorRefs.get(restored.editorId)!.applyDraftPrefill).toHaveBeenCalledExactlyOnceWith(view.draft);
    expect(view.drafts.size).toBe(0);
  });

  it("ignores the current session, foreign sessions and stale tab events", async () => {
    const view = fixture();
    const before = JSON.stringify(view.state);
    await view.select("main", { editorId: view.first.editorId, sessionId: "first" });
    await view.select("main", { editorId: view.first.editorId, sessionId: "foreign" });
    await view.select("main", { editorId: "closed-tab", sessionId: "second" });
    expect(JSON.stringify(view.state)).toBe(before);
    expect(view.open).not.toHaveBeenCalled();
  });

  it("retains the checkout constraint of an embedded workspace", async () => {
    const view = fixture();
    view.props.fixedWorkspaceRef = { checkoutId: "fixed-checkout" };
    await view.select("main", { editorId: view.first.editorId, sessionId: "second" });
    expect(view.state.groups.main!.tabs[0]!.checkoutBinding?.checkoutId).toBe("fixed-checkout");
  });
});
