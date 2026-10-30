/** One main-process queue shared by every destructive operation. Reject overlaps, never silently queue stale approvals. */
export class MutationCoordinator {
  private active: string | null = null;
  get operation(): string | null { return this.active; }
  async run<T>(name: string, action: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error(`Wait for ${this.active} to finish before starting another operation`);
    this.active = name;
    try { return await action(); } finally { this.active = null; }
  }
}
export const mutations = new MutationCoordinator();

/** Serialize the whole transaction, not just its final write. A failed transaction must not poison the queue. */
export function transactionQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(action: () => Promise<T>): Promise<T> => {
    const next = tail.then(action, action);
    tail = next.catch(() => undefined);
    return next;
  };
}
