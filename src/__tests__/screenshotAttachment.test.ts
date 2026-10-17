import { describe, expect, it } from "vitest";
import { buildChatMessageClipboardPayload, buildUserMessageDraft, readUserMessageDraftFromClipboardData, LOCUS_CHAT_MESSAGE_DRAFT_MIME } from "../composables/chatMessageDraft";
import { readSharedComposerDraft, writeSharedComposerDraft } from "../composables/chatComposerDraftMemory";
import type { ChatMessage } from "../types";

describe("screenshot attachment", () => {
  const message: ChatMessage = { id: "capture-message", role: "user", content: "Look here", createdAt: 1,
    images: [{ data: "png", mimeType: "image/png", capture: { id: "capture-42" } }] };
  it("keeps one image and its snapshot reference through retry, cross-window drafts and copy", () => {
    const draft = buildUserMessageDraft(message);
    writeSharedComposerDraft("capture-draft", draft);
    expect(readSharedComposerDraft("capture-draft")?.images).toEqual(message.images);
    const payload = buildChatMessageClipboardPayload(message);
    const restored = readUserMessageDraftFromClipboardData({ getData: (type: string) => type === LOCUS_CHAT_MESSAGE_DRAFT_MIME ? payload.serializedDraft ?? "" : "" } as DataTransfer);
    expect(restored?.images).toEqual(message.images);
    expect(restored?.localFiles).toEqual([]);
  });
  it("deleting the image removes its spatial reference from the draft as one unit", () => {
    const draft = buildUserMessageDraft(message);
    draft.images = [];
    writeSharedComposerDraft("capture-draft-delete", draft);
    expect(readSharedComposerDraft("capture-draft-delete")?.images).toEqual([]);
  });
});
