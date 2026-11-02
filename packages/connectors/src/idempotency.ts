/**
 * Process-local idempotency for post creation.
 *
 * None of the native networks we publish to gives us server-side dedup on "create post" (X and
 * Bluesky have no idempotency key; Zernio's is unverified), so a retry after a transient failure
 * would double-post. We remember settled results by idempotencyKey for the life of the process and
 * coalesce concurrent calls with the same key onto one in-flight promise.
 *
 * Limitation, by design: a process restart forgets everything. Core must persist externalIds as
 * soon as a publish resolves and treat a retry that crosses a restart as potentially duplicating.
 */
export class IdempotencyCache<T> {
  private readonly settled = new Map<string, T>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(private readonly maxEntries = 10_000) {}

  /** The settled result for a key, if any. Does not touch in-flight work. */
  peek(key: string): T | undefined {
    return this.settled.get(key);
  }

  /** Run `work` once per key: later callers get the cached result or join the in-flight call. */
  run(key: string, work: () => Promise<T>): Promise<T> {
    const done = this.settled.get(key);
    if (done !== undefined) return Promise.resolve(done);
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const p = work()
      .then((result) => {
        this.remember(key, result);
        return result;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  private remember(key: string, result: T): void {
    // Map iteration follows insertion order, so the first key is the oldest; a long-lived worker
    // must not grow this without bound.
    if (this.settled.size >= this.maxEntries) {
      const oldest = this.settled.keys().next().value;
      if (oldest !== undefined) this.settled.delete(oldest);
    }
    this.settled.set(key, result);
  }
}
