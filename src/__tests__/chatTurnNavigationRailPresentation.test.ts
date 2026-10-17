// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatTurnNavigationRail from "../components/chat/ChatTurnNavigationRail.vue";
import type { ChatMessage } from "../types";

vi.mock("../i18n", () => ({ t: (key: string, ...args: unknown[]) => [key, ...args].join(" ") }));

let app: App | undefined;
let host: HTMLElement;
let frames: FrameRequestCallback[] = [];

function message(id: string, role: ChatMessage["role"]): ChatMessage {
  return { id, role, content: `${role} ${id}`, createdAt: 0 };
}

function transcript(userIds: string[]) {
  const scroll = document.createElement("div");
  scroll.className = "chat-transcript-scroll";
  for (const id of userIds) {
    const stack = document.createElement("div");
    stack.className = "chat-transcript-item-stack";
    stack.dataset.chatMessageRole = "user";
    stack.dataset.chatMessageId = id;
    const content = document.createElement("div");
    content.className = "chat-transcript-message-content";
    content.append(stack);
    scroll.append(content);
  }
  document.body.append(scroll);
  return scroll;
}

function runFrames() {
  const pending = frames;
  frames = [];
  for (const callback of pending) callback(performance.now());
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    // The message column sits 96px into the transcript, leaving room for the rail.
    const left = this.classList.contains("chat-transcript-message-content") ? 96 : 0;
    return { left, top: 0, right: left + 400, bottom: 20, width: 400, height: 20, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountRail(props: Record<string, unknown>) {
  const state = reactive(props);
  const rail = ref<InstanceType<typeof ChatTurnNavigationRail> | null>(null);
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(ChatTurnNavigationRail, { ...state, ref: rail } as never) });
  app.mount(host);
  return { state, rail };
}

describe("turn navigation rail presentation", () => {
  it("is part of the first frame of a presented surface, without an entrance animation", async () => {
    const scroll = transcript(["u1", "u2"]);
    const { rail } = mountRail({
      messages: [message("u1", "user"), message("a1", "assistant"), message("u2", "user")],
      sessionId: "session",
      userMessageIds: ["u1", "u2"],
      scrollElement: scroll,
      presented: true,
    });
    expect(host.querySelector(".chat-turn-navigation-rail")).toBeNull();

    rail.value!.measureNow(scroll);
    await nextTick();
    const nav = host.querySelector(".chat-turn-navigation-rail");
    expect(nav).not.toBeNull();
    expect(nav!.classList.contains("is-entering")).toBe(false);
    expect(host.querySelectorAll(".chat-turn-navigation-button")).toHaveLength(2);
  });

  it("animates a rail that appears later in a transcript the user is looking at", async () => {
    const scroll = transcript([]);
    const { state } = mountRail({
      messages: [],
      sessionId: "session",
      userMessageIds: [],
      scrollElement: scroll,
      presented: true,
    });
    await nextTick();
    await nextTick();
    runFrames();
    runFrames();
    expect(host.querySelector(".chat-turn-navigation-rail")).toBeNull();

    // The first prompt of a new session arrives once the surface is settled.
    scroll.remove();
    const next = transcript(["u1"]);
    state.scrollElement = next;
    state.messages = [message("u1", "user")];
    state.userMessageIds = ["u1"];
    await nextTick();
    await nextTick();
    runFrames();
    await nextTick();
    expect(host.querySelector(".chat-turn-navigation-rail")?.classList.contains("is-entering")).toBe(true);
  });

  it("does not animate a rail that appears while its surface is not presented", async () => {
    const scroll = transcript(["u1"]);
    mountRail({
      messages: [message("u1", "user")],
      sessionId: "session",
      userMessageIds: ["u1"],
      scrollElement: scroll,
      presented: false,
    });
    await nextTick();
    await nextTick();
    runFrames();
    runFrames();
    await nextTick();
    expect(host.querySelector(".chat-turn-navigation-rail")?.classList.contains("is-entering")).toBe(false);
  });
});
