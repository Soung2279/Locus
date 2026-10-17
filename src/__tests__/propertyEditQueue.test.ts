import { describe, expect, it } from "vitest";
import { createPropertyEditQueue } from "../services/propertyEditQueue";

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
describe("ordered property edits", () => {
  it("coalesces only adjacent queued values and treats history/structure as barriers", async () => {
    const queue = createPropertyEditQueue();
    const calls: number[] = [];
    const run = (n: number) => async () => { calls.push(n); return n; };
    const results = await Promise.all([
      queue.enqueue(run(1), "a"), queue.enqueue(run(2), "a"),
      queue.enqueue(run(3)), queue.enqueue(run(4), "a"),
      queue.enqueue(run(5), "b"), queue.enqueue(run(6), "a"),
    ]);
    expect(calls).toEqual([2, 3, 4, 5, 6]);
    expect(results).toEqual([2, 2, 3, 4, 5, 6]);
  });
  it("never cancels dispatched work and allows later explicit recovery after failure", async () => {
    const queue = createPropertyEditQueue();
    let release!: () => void;
    const first = queue.enqueue(async () => { await new Promise<void>(r => { release = r; }); throw Error("failed"); }, "a");
    const caught = first.catch(e => e.message);
    await flush();
    const next = queue.enqueue(async () => 2, "a");
    const last = queue.enqueue(async () => 3, "a");
    release();
    expect(await caught).toBe("failed");
    expect(await next).toBe(3); expect(await last).toBe(3);
  });
});
