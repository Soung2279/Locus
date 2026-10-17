/** Ordered mutations with adjacent last-value-wins edits. Structural commands and
 * history operations are barriers. Already-dispatched work is never cancelled. */
export function createPropertyEditQueue() {
  type Waiter = { resolve: (value: unknown) => void; reject: (error: unknown) => void };
  type Job = { run: () => Promise<unknown>; key?: string; waiters: Waiter[] };
  const jobs: Job[] = [];
  let draining = false;
  async function drain() {
    try {
      while (jobs.length) {
        const job = jobs.shift()!;
        try {
          const result = await job.run();
          for (const waiter of job.waiters) waiter.resolve(result);
        } catch (error) {
          for (const waiter of job.waiters) waiter.reject(error);
        }
      }
    } finally { draining = false; }
  }
  return {
    enqueue<T>(run: () => Promise<T>, key?: string): Promise<T> {
      const promise = new Promise<T>((resolve, reject) => {
        const waiter: Waiter = { resolve: value => resolve(value as T), reject };
        const tail = jobs[jobs.length - 1];
        if (key && tail?.key === key) { tail.run = run; tail.waiters.push(waiter); }
        else jobs.push({ run, key, waiters: [waiter] });
      });
      if (!draining) { draining = true; queueMicrotask(() => { void drain(); }); }
      return promise;
    },
  };
}

/** Only ordinary scalar assignments may supersede an adjacent queued assignment.
 * Arrays, reference maps, vector parts, restore commands and structural edits keep order. */
export function isCoalesciblePropertyValue(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}
