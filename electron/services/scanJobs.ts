import type { ScanTask } from '../../shared/types';

/** A job survives screen navigation. Overlaps of the same task are rejected. */
export class ScanJobs {
  private active = new Map<ScanTask, AbortController>();
  async run<T>(task: ScanTask, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active.has(task)) throw new Error('This scan is already running');
    const controller = new AbortController();
    this.active.set(task, controller);
    try { return await work(controller.signal); } finally { this.active.delete(task); }
  }
  cancel(task: unknown): boolean {
    const controller = this.active.get(task as ScanTask);
    controller?.abort();
    return Boolean(controller);
  }
}
export function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Scan cancelled');
}
