import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cwd = process.cwd();

function read(relPath: string) {
  return readFileSync(resolve(cwd, relPath), "utf8");
}

describe("chat session switch stability", () => {
  it("commits the target session only after its first message page is ready", () => {
    const chatView = read("src/components/ChatView.vue");
    const transcript = read("src/components/chat/ChatTranscript.vue");
    const chatStore = read("src/stores/chat.ts");

    expect(chatStore).toContain("pendingSelectionSessionId.value = id;");
    expect(chatStore).toContain("sessionService.loadSessionView(id, messageLimit, synchronizeRemote),");
    expect(chatStore.indexOf("sessionService.loadSessionView(id, messageLimit, synchronizeRemote),")).toBeLessThan(
      chatStore.indexOf("setActiveSessionSelection(id, { persist: options.persist });"),
    );
    expect(chatStore).toContain("loadSeq !== sessionLoadSeq");
    expect(chatStore).toContain("!isWorkspaceScopeCurrent(expectedWorkspaceScopeKey)");
    expect(chatStore).toContain("sessionHistoryHasMore.value = snapshot.hasMoreHistory;");

    expect(chatView).toContain("function isPendingSessionRestoreAwaitingMessages()");
    expect(chatView).toContain("if (isPendingSessionRestoreAwaitingMessages()) return;");
    expect(chatView).toContain("function finishPendingSessionRestore(targetSessionId: string)");
    expect(chatView).toContain("const shouldRestoreImmediately = !!nextSessionId && previousSessionId === null && !showWelcomeState.value;");
    expect(chatView).toContain("scrollToBottomScheduler.cancel();");
    expect(chatView).toContain("pendingRestoreMessagesRef.value = nextSessionId && !shouldRestoreImmediately ? props.messages : null;");
    expect(chatView).toContain("if (shouldRestoreImmediately) {");
    expect(chatView).toContain("restorePendingSessionScroll({ defer: true });");
    expect(chatView).toContain("pendingRestoreMessagesRef.value = null;");
    expect(chatView).toContain("restorePendingSessionScroll();");
    expect(chatView).toContain("scheduleSessionRestoreFollowup(targetSessionId, remembered);");
    expect(chatView).toContain("function resolvePendingSessionRestoreState(state: SessionScrollState | null)");
    expect(chatView).toContain("shouldRestoreBottomFromTopAnchorState(");
    expect(chatView).not.toContain("traceSessionScroll");
    expect(chatView).not.toContain("[Locus chat-scroll]");
    expect(chatView).toContain('{ flush: "post" },');
    expect(chatView).toContain("const sessionRestoreLayoutStabilizing = ref(false);");
    expect(chatView).toContain("beginSessionRestoreLayoutStabilization();");
    expect(chatView).toContain("finishSessionRestoreLayoutStabilization({");
    expect(chatView).toContain("function isSessionRestoreViewportGuardActive()");
    expect(chatView).toContain("const sessionRestoreViewportGuarding = ref(false);");
    expect(chatView).toContain("sessionRestoreViewportGuarding.value = true;");
    expect(chatView).toContain("const userScrollIntent = createUserScrollIntentTracker();");
    expect(chatView).toContain("function markMessagesUserScrollIntent()");
    expect(chatView).toContain("if (!userScrollIntent.isRecent()) {");
    expect(chatView).toContain("@user-scroll-intent=\"markMessagesUserScrollIntent\"");
    expect(chatView).toContain("function finishSessionRestoreLayoutStabilization(");
    expect(chatView).toContain("const restoreUntilSettled = () => {");
    expect(chatView).toContain("SESSION_RESTORE_MAX_SETTLE_FRAMES");
    expect(chatView).toContain("SESSION_RESTORE_REQUIRED_STABLE_FRAMES");
    expect(chatView).toContain(":class=\"{ 'is-session-restore-stabilizing': sessionRestoreLayoutStabilizing }\"");
    expect(transcript).toContain("(e: \"userScrollIntent\", event: Event): void;");
    expect(transcript).toContain("@wheel.passive=\"emitUserScrollIntent\"");
    expect(transcript).toContain("@pointermove.passive=\"emitPointerMoveScrollIntent\"");
    expect(transcript).toContain(':data-scroll-anchor-id="group.endMessageId"');
    expect(transcript).not.toContain(".chat-transcript-scroll.is-session.is-session-restore-stabilizing .chat-transcript-message.is-session");
    expect(transcript).not.toContain("content-visibility:");
    expect(transcript).not.toContain("contain-intrinsic-size:");
    expect(transcript).toContain("contain: layout paint;");
    expect(chatView).not.toContain("chat-transcript-restoring");
    expect(chatView).not.toContain("visibility: hidden;");
  });

  it("paints a remounted workbench transcript at its final viewport in the first frame", () => {
    const chatView = read("src/components/ChatView.vue");
    const workbench = read("src/components/workbench/DevelopmentWorkbench.vue");
    const stack = read("src/components/workbench/WorkbenchEditorStack.vue");
    const editor = read("src/components/workbench/WorkbenchSessionEditor.vue");
    const embedded = read("src/composables/useEmbeddedChatSession.ts");
    const onMounted = chatView.slice(chatView.indexOf("onMounted(() => {"), chatView.indexOf("onUnmounted(() => {"));
    const reconcile = chatView.slice(
      chatView.indexOf("function reconcileViewport(forceBottom = false) {"),
      chatView.indexOf("if (toolHandoffViewportQuiet.value) {", chatView.indexOf("function reconcileViewport(forceBottom = false) {")),
    );

    expect(stack).toContain(':presented="presentedEditor?.editorId === editor.editorId"');
    expect(workbench).toContain('<template #default="{ editor, ready, interactive, contentActive, presented }">');
    expect(workbench).toContain(':presented="presented"');
    expect(editor).toContain(':presented="presented"');
    expect(editor).toContain("const contentReadiness = provideSurfaceContentReadiness();");
    expect(chatView).toContain("const surfacePresented = computed(() => props.presented !== false);");
    // Restores synchronously while mounting instead of after the first frame.
    expect(onMounted.indexOf("restoreMountedSessionViewport();")).toBeLessThan(
      onMounted.indexOf("connectTranscriptResizeObserver();"),
    );
    expect(chatView).toContain("if (!sessionId || !surfacePresented.value || pendingRestoreSessionId.value) return;");
    // A prepared surface is measured once, when it is presented.
    expect(reconcile).toContain("if (!surfacePresented.value) return;");
    expect(chatView).toContain("if (presented && !wasPresented) alignViewportForPresentation();");
    // Pointing at an idle session row preloads it; live sessions load at open time.
    expect(workbench.match(/@pointerover="handleSessionRowPointerOver"/g)).toHaveLength(2);
    expect(workbench.match(/@pointerdown.capture="handleTreePointerDown"/g)).toHaveLength(2);
    expect(workbench).toContain('row.classList.contains("has-session-runtime")');
    expect(embedded).toContain("const preload = takeSessionViewPreload(normalizedSessionId, messageLimit);");
    // Inline path statuses are resolved before the transcript renders.
    expect(embedded.indexOf("prefetchMessagePathStatuses(snapshot.session.messages)")).toBeLessThan(
      embedded.indexOf("applyLoadedSessionSnapshot(state, snapshot);"),
    );
  });

  it("requests older history from both top-position and zero-displacement scroll paths", () => {
    const chatView = read("src/components/ChatView.vue");
    const intentHandler = chatView.slice(
      chatView.indexOf("function markMessagesUserScrollIntent()"),
      chatView.indexOf("function captureCurrentSessionScrollState"),
    );
    const scrollHandler = chatView.slice(
      chatView.indexOf("function onMessagesScroll()"),
      chatView.indexOf("let transcriptResizeObserver"),
    );

    expect(intentHandler).toContain("preserveMessagesViewportForUserScroll();");
    expect(intentHandler).toContain("requestOlderHistoryAtTop();");
    expect(scrollHandler).toContain("requestOlderHistoryAtTop();");
    expect(scrollHandler.indexOf("requestOlderHistoryAtTop();")).toBeLessThan(
      scrollHandler.indexOf("if (!userScrollIntent.isRecent())"),
    );
    expect(chatView).toContain("for (let frameCount = 0; frameCount < SESSION_RESTORE_MAX_SETTLE_FRAMES;");
    expect(chatView).toContain("candidate.dataset.scrollAnchorId === anchor.anchorId");
  });
});
