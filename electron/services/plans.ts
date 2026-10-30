import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { shell } from 'electron';
import { assertDestructiveFeaturesEnabled } from '../../shared/safety';
import type { CleanResult, RemovalPlan, RemovalAction } from '../../shared/types';
import { fileIdentity, sameIdentity, isInside, normalizePath, type FileIdentity } from './pathSafety';
import { mutations } from './mutations';
import { walk, incompleteWalk } from './walk';
import { isPersonalPath } from './personalPolicy';
import { checkCancelled } from './scanJobs';

const MAX_ITEMS = 10_000;
const TTL = 5 * 60_000;
export interface PlannedItem { identity: FileIdentity; action: RemovalAction; tree?: FileIdentity[]; hash?: string }
interface StoredPlan { preview: RemovalPlan; items: PlannedItem[]; keepers: PlannedItem[] }
export interface PlanAdapter { validate(item: PlannedItem): Promise<void>; remove(item: PlannedItem): Promise<void> }

/** Immutable main-process manifests; execution accepts only an opaque, expiring, single-use token. */
export class PlanStore {
  private plans = new Map<string, StoredPlan>();
  constructor(private readonly now = Date.now) {}
  create(items: PlannedItem[], keepers: PlannedItem[] = [], batch?: RemovalPlan['batch']): RemovalPlan {
    if (!items.length || items.length > MAX_ITEMS) throw new Error('Select between 1 and 10,000 files');
    if (new Set(items.map(i => normalizePath(i.identity.path))).size !== items.length) throw new Error('Duplicate targets in preview');
    for (const [id, p] of this.plans) if (p.preview.expiresAt <= this.now()) this.plans.delete(id);
    if (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value!);
    const preview: RemovalPlan = { id: randomUUID(), expiresAt: this.now() + TTL, batch,
      items: items.map(i => ({ path: i.identity.path, size: i.identity.directory ? (i.tree ?? []).filter(f => !f.directory).reduce((s,f) => s+f.size,0) : i.identity.size, action: i.action })) };
    this.plans.set(preview.id, structuredClone({ preview, items, keepers }));
    return structuredClone(preview);
  }
  async revise(id: unknown, paths: unknown, signal?: AbortSignal): Promise<RemovalPlan> {
    const old = typeof id === 'string' ? this.plans.get(id) : undefined;
    if (!old || old.preview.expiresAt <= this.now()) throw new Error('Preview expired; preview again');
    if (!Array.isArray(paths) || paths.length > MAX_ITEMS || paths.some(p => typeof p !== 'string')) throw new Error('Select files to keep in this preview');
    const selected = new Set(paths.map(p => normalizePath(p)));
    const items = old.items.filter(i => selected.has(normalizePath(i.identity.path)));
    if (items.length !== selected.size) throw new Error('A revised preview cannot add files');
    for (const item of [...old.keepers, ...items]) await validatePlannedItem(item, signal);
    this.plans.delete(old.preview.id);
    if (!items.length) return { id: randomUUID(), expiresAt: this.now(), items: [], batch: old.preview.batch };
    return this.create(items, old.keepers, old.preview.batch);
  }
  async execute(id: unknown, adapter: PlanAdapter): Promise<CleanResult> {
    return mutations.run('file removal', async () => {
      const plan = typeof id === 'string' ? this.plans.get(id) : undefined;
      if (!plan) throw new Error('Preview the selection again');
      this.plans.delete(plan.preview.id);
      if (plan.preview.expiresAt <= this.now()) throw new Error('Preview expired; scan and preview again');
      for (const item of [...plan.keepers, ...plan.items]) await adapter.validate(item);
      const result: CleanResult = { freed: 0, freedMeasured: false, movedToTrash: 0, removed: 0, failed: 0, skipped: [], outcomes: [] };
      for (const [index, item] of plan.items.entries()) {
        try {
          for (const keeper of plan.keepers) await adapter.validate(keeper);
          await adapter.validate(item);
          await adapter.remove(item);
          result.removed++;
          result.outcomes!.push({ path: item.identity.path, action: item.action, status: 'removed' });
          if (item.action === 'trash') result.movedToTrash! += plan.preview.items[index].size;
          // Logical length is not actual reclaimed storage (hard links, compression, snapshots).
        } catch {
          result.failed += plan.items.length - index;
          result.outcomes!.push(...plan.items.slice(index).map((pending, i) => ({ path: pending.identity.path, action: pending.action, status: i === 0 ? 'failed' as const : 'skipped' as const })));
          result.skipped.push('Stopped: a file changed, became unavailable or could not be removed. Preview the remaining files again.');
          break;
        }
      }
      return result;
    });
  }
}

export async function snapshotTree(p: string, signal?: AbortSignal): Promise<FileIdentity[]> {
  const paths: string[] = [];
  const stats = await walk(p, { signal, maxEntries: MAX_ITEMS, onFile: f => paths.push(f.path), onDir: dir => paths.push(dir) });
  checkCancelled(signal);
  if (incompleteWalk(stats)) throw new Error('Folder could not be completely inspected; it will not be removed');
  const entries: FileIdentity[] = [];
  for (const file of paths.sort()) { checkCancelled(signal); entries.push(await fileIdentity(file)); }
  return entries;
}

async function contentHash(p: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(p, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

export async function plannedItem(p: string, action: RemovalAction, expectedHash?: string, signal?: AbortSignal): Promise<PlannedItem> {
  checkCancelled(signal);
  const identity = await fileIdentity(p);
  const tree = identity.directory ? await snapshotTree(p, signal) : undefined;
  if (action === 'delete' && identity.directory) throw new Error('Permanent folder deletion is not supported');
  if (action === 'trash' && (!isPersonalPath(p) || tree?.some(f => !isPersonalPath(f.path)))) throw new Error('Only ordinary personal files can be moved to Trash');
  let hash: string | undefined;
  if (expectedHash) {
    if (identity.directory) throw new Error('Duplicate must be a file');
    hash = await contentHash(p, signal);
    if (hash !== expectedHash) throw new Error('Duplicate contents changed; scan again');
  }
  if (!sameIdentity(identity, await fileIdentity(p))) throw new Error('File changed while preparing preview');
  return { identity, action, tree, hash };
}

export async function validatePlannedItem(item: PlannedItem, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  if (!sameIdentity(item.identity, await fileIdentity(item.identity.path))) throw new Error('Stale file identity');
  if (item.tree) {
    const current = await snapshotTree(item.identity.path, signal);
    if (current.length !== item.tree.length || current.some((s,i) => !sameIdentity(s,item.tree![i]))) throw new Error('Folder contents changed');
  }
  if (item.hash && await contentHash(item.identity.path, signal) !== item.hash) throw new Error('Duplicate contents changed');
  if (!sameIdentity(item.identity, await fileIdentity(item.identity.path))) throw new Error('File changed during validation');
}

export const removalPlans = new PlanStore();
export const revisePlan = (id: unknown, paths: unknown, signal?: AbortSignal) => removalPlans.revise(id, paths, signal);
export async function previewTrash(paths: unknown, signal?: AbortSignal): Promise<RemovalPlan> {
  if (!Array.isArray(paths) || paths.length > MAX_ITEMS || paths.some(p => !isPersonalPath(p))) throw new Error('Select ordinary personal files only');
  const unique = [...new Set(paths as string[])];
  if (unique.some(p => unique.some(other => isInside(other, p)))) throw new Error('Select a folder or its children, not both');
  const items: PlannedItem[] = [];
  for (const p of unique) items.push(await plannedItem(p, 'trash', undefined, signal));
  return removalPlans.create(items);
}

export async function previewDuplicates(groups: unknown, signal?: AbortSignal): Promise<RemovalPlan> {
  if (!Array.isArray(groups) || !groups.length || groups.length > 200) throw new Error('Invalid duplicate selection');
  const items: PlannedItem[] = [], keepers: PlannedItem[] = [];
  for (const group of groups) {
    checkCancelled(signal);
    if (!group || typeof group.hash !== 'string' || !/^[a-f0-9]{64}$/.test(group.hash) || !isPersonalPath(group.keeper) ||
      !Array.isArray(group.remove) || !group.remove.length || group.remove.length > MAX_ITEMS) throw new Error('Invalid duplicate group');
    keepers.push(await plannedItem(group.keeper, 'trash', group.hash, signal));
    for (const p of group.remove) {
      if (!isPersonalPath(p)) throw new Error('Protected duplicate');
      const item = await plannedItem(p, 'trash', group.hash, signal);
      items.push(item);
      if (items.length > MAX_ITEMS) throw new Error('Too many duplicate files');
    }
  }
  if (keepers.some(k => items.some(i => i.identity.device === k.identity.device && i.identity.inode === k.identity.inode))) throw new Error('Keeper also selected for removal');
  return removalPlans.create(items, keepers);
}

export async function executePlan(id: unknown): Promise<CleanResult> {
  assertDestructiveFeaturesEnabled();
  // Keep locked until native Windows/macOS race and recovery acceptance tests are complete.
  return removalPlans.execute(id, { validate: validatePlannedItem, remove: async item => {
    assertDestructiveFeaturesEnabled();
    if (item.action === 'trash') await shell.trashItem(item.identity.path);
    else await fs.unlink(item.identity.path);
  } });
}
