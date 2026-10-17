// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { synchronizeDocument } from "../services/sharedWorkbenchWindow";

const releases: Array<() => void> = [];
afterEach(() => {
  releases.splice(0).forEach(release => release());
  document.body.replaceChildren();
  document.head.querySelectorAll('[data-test-shared-style]').forEach(node => node.remove());
});
describe("shared document styles", () => {
  it("keeps stylesheet nodes when a parked document is rebound and still propagates real edits", async () => {
    const style = document.createElement("style"); style.dataset.testSharedStyle = "";
    style.textContent = ".shared-fixture { color: red }"; document.head.append(style);
    const frame = document.createElement("iframe"); document.body.append(frame);
    const child = frame.contentWindow!;
    const first = synchronizeDocument(child, "first");
    const original = child.document.head.querySelector('[data-test-shared-style]');
    expect(original?.textContent).toBe(style.textContent);
    first.dispose(); first.container.remove();
    const second = synchronizeDocument(child, "second"); releases.push(second.dispose);
    expect(child.document.head.querySelector('[data-test-shared-style]')).toBe(original);
    expect(child.document.querySelector('[data-locus-shared-workbench-host="first"]')).toBeNull();
    style.textContent = ".shared-fixture { color: blue }";
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(child.document.head.querySelector('[data-test-shared-style]')?.textContent).toBe(style.textContent);
    second.dispose();
    style.textContent = ".shared-fixture { color: green }";
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(child.document.head.querySelector('[data-test-shared-style]')?.textContent).toContain("blue");
  });
});
