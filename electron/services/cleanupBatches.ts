import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { RemovalAction, RemovalPlan } from '../../shared/types';
import { plannedItem, removalPlans, type PlannedItem } from './plans';
import { checkCancelled } from './scanJobs';
import { excluded } from './discovery';
import { isInside } from './pathSafety';

export interface CleanupCandidate { path: string; action: RemovalAction; cutoff?: number }
interface Batch { candidates: CleanupCandidate[]; offset: number; expires: number; limited: boolean; ids: string[] }
const batches = new Map<string, Batch>();
export function startCleanupBatches(candidates: CleanupCandidate[], ids: string[], limited: boolean): string {
  for (const [id, batch] of batches) if (batch.expires < Date.now()) batches.delete(id);
  while (batches.size >= 3) batches.delete(batches.keys().next().value!);
  const id = randomUUID();
  batches.set(id, { candidates: structuredClone(candidates), offset: 0, expires: Date.now() + 30 * 60_000, limited, ids: [...ids] });
  return id;
}
/** Cursor refers to a fixed candidate inventory, never a renderer-provided offset or path. */
export async function nextCleanupBatch(cursor: unknown, ids: string[], exclusions: string[], signal?: AbortSignal): Promise<RemovalPlan> {
  const batch = typeof cursor === 'string' ? batches.get(cursor) : undefined;
  if (!batch || batch.expires < Date.now() || JSON.stringify(ids) !== JSON.stringify(batch.ids)) throw new Error('Batch expired or selection changed; start a new preview');
  batches.delete(cursor as string);
  const items: PlannedItem[] = [];
  let skipped = 0;
  while (batch.offset < batch.candidates.length && items.length < 500) {
    checkCancelled(signal);
    const candidate = batch.candidates[batch.offset++];
    if (excluded(candidate.path, exclusions) || (candidate.action === 'trash' && exclusions.some(e => isInside(candidate.path, e)))) { skipped++; continue; }
    try {
      const item = await plannedItem(candidate.path, candidate.action, undefined, signal);
      if (candidate.cutoff !== undefined) {
        const st = await fs.lstat(candidate.path);
        if (Math.max(st.mtimeMs, st.birthtimeMs) >= candidate.cutoff) { skipped++; continue; }
      }
      items.push(item);
    } catch { checkCancelled(signal); skipped++; }
  }
  checkCancelled(signal);
  if (!items.length) throw new Error('No eligible files remain in this batch inventory. Rescan to refresh results.');
  const next = batch.offset < batch.candidates.length ? randomUUID() : undefined;
  if (next) batches.set(next, batch);
  return removalPlans.create(items, [], { cursor: next, remaining: batch.candidates.length - batch.offset, skipped, limited: batch.limited });
}
