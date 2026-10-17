// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMarkdownDocumentOutline } from "../composables/useMarkdownDocumentOutline";

let app: App | null = null;
afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe("Markdown outline placement", () => {
  it("starts below properties, follows property height changes and keeps a stable offset while scrolling", async () => {
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let onResize: (() => void) | undefined;
    const observed: Element[] = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { onResize = callback; }
      observe(element: Element) { observed.push(element); }
      disconnect() {}
    });

    const scroller = ref<HTMLElement | null>(null);
    const page = ref<HTMLElement | null>(null);
    const body = ref<HTMLElement | null>(null);
    const prose = ref<HTMLElement | null>(null);
    let outline!: ReturnType<typeof useMarkdownDocumentOutline>;
    const root = document.createElement("div"); document.body.append(root);
    app = createApp({ setup() {
      outline = useMarkdownDocumentOutline({
        documentKey: () => "example", source: () => "# Body", active: () => true,
        scroller, page, body, bodyStart: () => prose.value, editor: ref(null),
      });
      return () => h("div", { ref: scroller }, h("article", { ref: page }, h("section", { ref: body }, [
        h("section", { class: "properties" }), h("div", { ref: prose }),
      ])));
    } });
    app.mount(root); await nextTick();
    let scrollOffset = 0;
    let proseTop = 420;
    scroller.value!.getBoundingClientRect = () => new DOMRect(0, 20, 1200, 720);
    page.value!.getBoundingClientRect = () => new DOMRect(0, 20 - scrollOffset, 900, 1800);
    body.value!.getBoundingClientRect = () => new DOMRect(0, 100 - scrollOffset, 900, 1700);
    prose.value!.getBoundingClientRect = () => new DOMRect(0, proseTop - scrollOffset, 900, 1300);
    Object.defineProperty(scroller.value, "clientHeight", { value: 720 });
    const flush = () => { const callback = frame; frame = null; callback?.(0); };
    outline.scheduleDocumentOutlineActiveUpdate(); flush();
    expect(outline.documentOutlineMarginTop.value).toBe("384px");
    expect(observed).toContain(prose.value);

    proseTop = 164;
    onResize?.(); flush();
    expect(outline.documentOutlineMarginTop.value).toBe("128px");
    scrollOffset = 300;
    outline.scheduleDocumentOutlineActiveUpdate(); flush();
    expect(outline.documentOutlineMarginTop.value).toBe("128px");
    expect(outline.documentOutlineMaxHeight.value).toBe("656px");

    prose.value = null; await nextTick(); flush();
    expect(outline.documentOutlineMarginTop.value).toBe("64px");
  });
});
