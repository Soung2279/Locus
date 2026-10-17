// @vitest-environment jsdom
import { createApp, h, nextTick, Teleport, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BaseDropdown from "../components/ui/BaseDropdown.vue";
import UnityObjectReferenceField from "../components/unity/UnityObjectReferenceField.vue";
import { searchWorkspaceAssets } from "../services/asset";

vi.mock("../stores/workspaceContext", () => ({
  useWorkspaceContextStore: () => ({ focusedWorkspaceRef: { checkoutId: "test", expectedGeneration: 1 } }),
}));
vi.mock("../services/asset", () => ({
  previewWorkspaceAssetThumbnail: vi.fn(async () => ({ url: "" })),
  searchWorkspaceAssets: vi.fn(async () => [{
    path: "Assets/Death.asset", name: "Death.asset", kind: "asset", typeLabel: "EcsActionAsset",
    root: "assets", isSubAsset: false,
  }]),
}));

const cleanups: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function flush() {
  await nextTick();
  await vi.advanceTimersByTimeAsync(100);
  await nextTick();
}

// Shared workbench windows render through the opener's Vue runtime. An iframe
// gives the trigger a separate document/viewport without changing that runtime.
async function mountDropdown(kind: "reference" | "base", detached = true, teleport = true) {
  const frame = document.createElement("iframe");
  if (detached) document.body.append(frame);
  const ownerDocument = detached ? frame.contentDocument! : document;
  const ownerWindow = ownerDocument.defaultView!;
  const viewport = { width: 640, height: 480 };
  vi.spyOn(ownerWindow, "innerWidth", "get").mockImplementation(() => viewport.width);
  vi.spyOn(ownerWindow, "innerHeight", "get").mockImplementation(() => viewport.height);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(ownerWindow, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  const cancelFrame = vi.spyOn(ownerWindow, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const scrollIntoView = vi.fn();
  const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  const host = document.createElement("div");
  document.body.append(host);
  const update = vi.fn();
  const commit = vi.fn();
  const component: Component = kind === "reference" ? UnityObjectReferenceField : BaseDropdown;
  const props = kind === "reference"
    ? { modelValue: "Assets/Death.asset", referenceTypeFullName: "EcsActionAsset", onCommit: commit }
    : { modelValue: "one", options: [{ value: "one", label: "One" }, { value: "two", label: "Two" }], teleport };
  const app = createApp({ render: () => h(Teleport, { to: ownerDocument.body }, h(component, {
    ...props, "onUpdate:modelValue": update,
  })) });
  app.mount(host);
  const rootSelector = kind === "reference" ? ".unity-object-reference-field" : ".base-dropdown";
  const menuSelector = kind === "reference" ? ".unity-object-reference-dropdown" : ".base-dropdown-menu";
  const root = ownerDocument.querySelector<HTMLElement>(rootSelector)!;
  const trigger = root.querySelector<HTMLButtonElement>("button")!;
  let bounds = new DOMRect(500, 360, 120, 26);
  vi.spyOn(root, "getBoundingClientRect").mockImplementation(() => bounds);
  vi.spyOn(trigger, "getBoundingClientRect").mockImplementation(() => bounds);
  let mounted = true;
  const unmount = () => { if (mounted) app.unmount(); mounted = false; };
  cleanups.push(() => {
    unmount(); host.remove(); frame.remove();
    if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });
  trigger.focus();
  trigger.click();
  await flush();
  const menu = () => ownerDocument.querySelector<HTMLElement>(menuSelector);
  if (kind === "base" && menu()) {
    vi.spyOn(menu()!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 220, 200));
    vi.spyOn(menu()!, "scrollHeight", "get").mockReturnValue(200);
  }
  const reposition = async () => {
    ownerWindow.dispatchEvent(new Event("resize"));
    for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); }
    await nextTick();
  };
  await reposition();
  return {
    ownerDocument, ownerWindow, viewport, root, trigger, menu, menuSelector,
    update, commit, unmount, reposition, cancelFrame, scrollIntoView,
    setBounds: (next: DOMRect) => { bounds = next; },
    flushFrames: async () => {
      for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); }
      await nextTick();
    },
  };
}

describe.each(["reference", "base"] as const)("%s dropdown window ownership", (kind) => {
  it.each([false, true])("renders beside its trigger in the correct window (detached: %s)", async (detached) => {
    const fixture = await mountDropdown(kind, detached);
    expect(fixture.menu()).not.toBeNull();
    expect(fixture.menu()!.parentElement).toBe(fixture.ownerDocument.body);
    if (detached) expect(document.querySelector(fixture.menuSelector)).toBeNull();
    expect(fixture.menu()!.style.left).toBe(kind === "reference" ? "412px" : "400px");
    if (kind === "reference") expect(fixture.menu()!.style.bottom).toBe("124px");
    else expect(fixture.menu()!.style.top).toBe("154px");
  });

  it("follows the owning viewport and scroll container", async () => {
    const fixture = await mountDropdown(kind);
    fixture.viewport.width = 480;
    fixture.viewport.height = 440;
    await fixture.reposition();
    expect(fixture.menu()!.style.left).toBe("252px");
    if (kind === "reference") expect(fixture.menu()!.style.bottom).toBe("84px");

    fixture.setBounds(new DOMRect(24, 40, 120, 26));
    fixture.root.dispatchEvent(new Event("scroll"));
    await fixture.flushFrames();
    expect(fixture.menu()!.style.left).toBe(kind === "reference" ? "24px" : "8px");
    expect(fixture.menu()!.style.top).toBe(kind === "reference" ? "70px" : "72px");
  });

  it.each(["close", "unmount"])("releases owner listeners and scheduled positioning on %s", async (action) => {
    const fixture = await mountDropdown(kind);
    const removeDocument = vi.spyOn(fixture.ownerDocument, "removeEventListener");
    const removeWindow = vi.spyOn(fixture.ownerWindow, "removeEventListener");
    fixture.ownerWindow.dispatchEvent(new Event("resize"));
    if (action === "unmount") fixture.unmount();
    else {
      const target = kind === "reference" ? fixture.menu()!.querySelector("input")! : fixture.trigger;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    await nextTick();
    expect(removeWindow).toHaveBeenCalledWith("resize", expect.any(Function));
    if (kind === "reference") {
      expect(removeDocument).toHaveBeenCalledWith("scroll", expect.any(Function), true);
      expect(fixture.cancelFrame).toHaveBeenCalled();
    } else {
      expect(removeDocument).toHaveBeenCalledWith("click", expect.any(Function), true);
      expect(removeWindow).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    }
  });
});

it("keeps reference search focused, scrolls options and commits from the detached window", async () => {
  const fixture = await mountDropdown("reference");
  const search = fixture.menu()!.querySelector<HTMLInputElement>("input")!;
  expect(fixture.ownerDocument.activeElement).toBe(search);
  expect(searchWorkspaceAssets).toHaveBeenCalled();
  const selectedId = search.getAttribute("aria-activedescendant");
  expect(fixture.scrollIntoView.mock.contexts).toContain(fixture.ownerDocument.getElementById(selectedId!));
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await nextTick();
  expect(fixture.update).toHaveBeenCalledWith("Assets/Death.asset");
  expect(fixture.commit).toHaveBeenCalledWith("Assets/Death.asset");
  expect(fixture.ownerDocument.activeElement).toBe(fixture.trigger);
  expect(fixture.menu()).toBeNull();
});

it("closes reference search when focus leaves the field and popup in its own document", async () => {
  const fixture = await mountDropdown("reference");
  const outside = fixture.ownerDocument.createElement("button");
  fixture.ownerDocument.body.append(outside);
  outside.focus();
  await flush();
  expect(fixture.menu()).toBeNull();
});

it.each([false, true])("handles outside clicks and keyboard selection in owner document (teleport: %s)", async (teleport) => {
  const fixture = await mountDropdown("base", true, teleport);
  expect(fixture.menu()!.parentElement).toBe(teleport ? fixture.ownerDocument.body : fixture.root);
  document.body.click();
  await nextTick();
  expect(fixture.trigger.getAttribute("aria-expanded")).toBe("true");
  fixture.ownerDocument.body.click();
  await nextTick();
  expect(fixture.trigger.getAttribute("aria-expanded")).toBe("false");
  fixture.trigger.click();
  await nextTick();
  fixture.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await nextTick();
  const activeId = fixture.trigger.getAttribute("aria-activedescendant");
  expect(fixture.scrollIntoView.mock.contexts).toContain(fixture.ownerDocument.getElementById(activeId!));
  fixture.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await nextTick();
  expect(fixture.update).toHaveBeenCalledWith("two");
  expect(fixture.ownerDocument.activeElement).toBe(fixture.trigger);
});
