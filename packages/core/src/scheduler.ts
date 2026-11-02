/** Where "publish this post at that time" is handed off. BullMQ in production; timers or memory in dev/tests. */
export interface Scheduler {
  schedulePublish(postId: string, at: Date): Promise<void>;
  cancelPublish(postId: string): Promise<void>;
}

/** Records intent only; tests drive publishing explicitly. */
export class InMemoryScheduler implements Scheduler {
  readonly jobs = new Map<string, Date>();
  async schedulePublish(postId: string, at: Date): Promise<void> {
    this.jobs.set(postId, at);
  }
  async cancelPublish(postId: string): Promise<void> {
    this.jobs.delete(postId);
  }
}

/** In-process timers for single-node dev. Not durable: a restart forgets pending jobs (the API re-arms from the database on boot). */
export class TimerScheduler implements Scheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(
    private readonly run: (postId: string) => Promise<void>,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async schedulePublish(postId: string, at: Date): Promise<void> {
    await this.cancelPublish(postId);
    this.arm(postId, at);
  }

  /** setTimeout caps at ~24.8 days; longer waits re-arm instead of firing early. */
  private arm(postId: string, at: Date): void {
    const remaining = at.getTime() - this.now().getTime();
    const MAX = 2 ** 31 - 1;
    const t = setTimeout(() => {
      this.timers.delete(postId);
      if (at.getTime() - this.now().getTime() > 1000) {
        this.arm(postId, at);
        return;
      }
      this.run(postId).catch((e) => console.error(`[scheduler] publish ${postId} failed`, e));
    }, Math.max(0, Math.min(remaining, MAX)));
    t.unref?.();
    this.timers.set(postId, t);
  }
  async cancelPublish(postId: string): Promise<void> {
    const t = this.timers.get(postId);
    if (t) clearTimeout(t);
    this.timers.delete(postId);
  }
}
