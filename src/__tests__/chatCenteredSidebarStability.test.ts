
import { describe, expect, it } from "vitest";
import {
  CHAT_WORKSPACE_CONTENT_MAX_WIDTH,
  resolveChatContentBalanceInset,
} from "../components/chat/chatSidebarBalance";

describe("centered chat sidebar stability", () => {
  it("balances the right sidebar only while the centered column still fits", () => {
    expect(CHAT_WORKSPACE_CONTENT_MAX_WIDTH).toBe(980);
    expect(resolveChatContentBalanceInset(1260, 280)).toBe(280);
    expect(resolveChatContentBalanceInset(1259, 280)).toBe(0);
    expect(resolveChatContentBalanceInset(1260, 0)).toBe(0);
    expect(resolveChatContentBalanceInset(Number.NaN, 280)).toBe(0);
  });
});
