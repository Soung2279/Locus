// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceNavigationMode } from "../composables/useWorkspaceNavigationMode";

const key = "locus:workspaceNavigationModes";
function sync() { window.dispatchEvent(new StorageEvent("storage", { key })); }
beforeEach(() => { localStorage.clear(); sync(); });

describe("workspace navigation mode", () => {
  it("defaults existing and new workspaces to sessions without changing their layouts", () => {
    localStorage.setItem("locus-display-settings", JSON.stringify({ workspaceDisplayMode: "multi" }));
    const settings = useWorkspaceNavigationMode();
    expect(settings.getMode("existing")).toBe("sessions");
    expect(settings.getMode(undefined)).toBe("sessions");
    settings.setMode("existing", "files");
    expect(JSON.parse(localStorage.getItem("locus-display-settings")!)).toEqual({ workspaceDisplayMode: "multi" });
  });

  it("persists independently for each checkout and restores in another window", () => {
    const first = useWorkspaceNavigationMode();
    first.setMode("checkout-a", "files");
    expect(first.getMode("checkout-a")).toBe("files");
    expect(first.getMode("checkout-b")).toBe("sessions");
    const saved = localStorage.getItem(key)!;
    localStorage.clear(); sync();
    expect(first.getMode("checkout-a")).toBe("sessions");
    localStorage.setItem(key, saved); sync();
    const second = useWorkspaceNavigationMode();
    expect(second.getMode("checkout-a")).toBe("files");
    second.setMode("checkout-b", "files");
    first.setMode("checkout-a", "sessions");
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ "checkout-a": "sessions", "checkout-b": "files" });
  });

  it("recovers invalid preferences and reacts to storage deletion", () => {
    const settings = useWorkspaceNavigationMode();
    localStorage.setItem(key, '{"a":"files","b":"invalid","c":null}'); sync();
    expect(settings.getMode("a")).toBe("files");
    expect(settings.getMode("b")).toBe("sessions");
    localStorage.setItem(key, "invalid json"); sync();
    expect(settings.getMode("a")).toBe("sessions");
    settings.setMode("a", "files");
    localStorage.removeItem(key); sync();
    expect(settings.getMode("a")).toBe("sessions");
  });
});
