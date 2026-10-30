import { useEffect, useRef, useState } from 'react';
import { api, isDemo } from '../api';
import { DESTRUCTIVE_FEATURES_ENABLED, SAFETY_NOTICE } from '../../shared/safety';
import type { RemovalPlan } from '../../shared/types';
import { formatBytes } from '../lib/format';
import { useStore } from '../state';

type NextBatch = (cursor: string) => Promise<RemovalPlan>;
export function useRemovalPreview() {
  const [plan, setPlan] = useState<RemovalPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [omit, setOmit] = useState<Set<string>>(new Set());
  const active = useRef(false);
  const region = useRef<HTMLElement>(null);
  const nextBatch = useRef<NextBatch | undefined>(undefined);
  useEffect(() => { if (plan) region.current?.scrollIntoView({ block: 'start' }); }, [plan]);
  const after = useRef<(() => Promise<void>) | undefined>(undefined);
  const { toast, refreshDisk, smartScan, settings, updateSettings } = useStore();
  const request = async (prepare: () => Promise<RemovalPlan>, onComplete?: () => Promise<void>, next?: NextBatch) => {
    if (active.current) return;
    active.current = true; setBusy(true); setPlan(null); setOmit(new Set());
    try { setPlan(await prepare()); after.current = onComplete; nextBatch.current = next; }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not prepare preview', 'err'); }
    finally { active.current = false; setBusy(false); }
  };
  const revise = async (remember: boolean) => {
    if (!plan || active.current || !omit.size) return;
    active.current = true; setBusy(true);
    try {
      if (remember) await updateSettings({ excludedPaths: [...new Set([...(settings?.excludedPaths ?? []), ...omit])] });
      const paths = plan.items.filter(i => !omit.has(i.path)).map(i => i.path);
      const revised = await api.revisePlan(plan.id, paths);
      if (revised.items.length) setPlan(revised);
      else if (revised.batch?.cursor && nextBatch.current) setPlan(await nextBatch.current(revised.batch.cursor));
      else setPlan(null);
      setOmit(new Set());
    } catch (e) { setPlan(null); toast(e instanceof Error ? e.message : 'Preview changed; prepare it again', 'err'); }
    finally { active.current = false; setBusy(false); }
  };
  const execute = async () => {
    if (!DESTRUCTIVE_FEATURES_ENABLED || !plan || omit.size || active.current) return;
    active.current = true; setBusy(true);
    try {
      const result = await api.executePlan(plan.id); setPlan(null);
      toast(`${result.removed} items removed; ${formatBytes(result.movedToTrash ?? 0)} moved to Trash. ${result.failed} failed. Free space is remeasured.`, result.failed ? 'err' : 'ok');
      await Promise.all([refreshDisk(), smartScan(), after.current?.()]);
    } catch (e) { setPlan(null); toast(e instanceof Error ? e.message : 'Removal stopped; preview again', 'err'); }
    finally { active.current = false; setBusy(false); }
  };
  const dialog = plan ? (
    <section ref={region} className="card-w panel" role="region" aria-label="Removal preview" style={{ padding: 20, marginTop: 16 }}>
      <h2>Removal preview · {plan.items.length} items</h2>
      <p>No files have been changed. Approval expires in five minutes. Uncheck files to exclude them, then update the preview.</p>
      {plan.batch && <p>{plan.batch.remaining.toLocaleString()} inventory entries remain after this batch · {plan.batch.skipped} unavailable or excluded items skipped. {plan.batch.limited && 'Inventory is partial because a limit or inaccessible path was encountered. Narrow the categories or exclusions and rescan for the rest.'}</p>}
      <div style={{ maxHeight: 360, overflow: 'auto' }} tabIndex={0} aria-label="All selected paths">
        <ul>{plan.items.map(i => <li key={i.path} style={{ overflowWrap: 'anywhere', marginBottom: 12 }}><label><input type="checkbox" checked={!omit.has(i.path)} disabled={busy} aria-label={`Include ${i.path}`} onChange={() => setOmit(s => { const n = new Set(s); if (n.has(i.path)) n.delete(i.path); else n.add(i.path); return n; })} /> <b>{i.action === 'delete' ? 'Permanent deletion' : 'Move to Trash'}</b> · {formatBytes(i.size)}<br />{i.path}</label></li>)}</ul>
      </div>
      {omit.size > 0 && <p><button className="btn small" disabled={busy} onClick={() => void revise(false)}>Update preview — exclude {omit.size}</button>{' '}<button className="btn small" disabled={busy || isDemo} onClick={() => void revise(true)}>Always ignore unchecked paths</button></p>}
      {!DESTRUCTIVE_FEATURES_ENABLED && <p>{SAFETY_NOTICE}</p>}
      <button type="button" className="btn" onClick={() => setPlan(null)} disabled={busy}>Close preview</button>{' '}
      {plan.batch?.cursor && nextBatch.current && <button className="btn" disabled={busy || omit.size > 0} onClick={() => { const cursor = plan.batch!.cursor!; const next = nextBatch.current!; void request(() => next(cursor), after.current, next); }}>Review next batch (skip this one)</button>}{' '}
      <button type="button" className="btn danger" disabled={!DESTRUCTIVE_FEATURES_ENABLED || busy || omit.size > 0 || Date.now() >= plan.expiresAt} onClick={() => void execute()}>Confirm removal</button>
    </section>
  ) : busy ? <p role="status">Preparing an exact preview. Nothing is being removed. <button className="btn small" onClick={() => void api.cancelScan('preview').catch(e => toast(String(e), 'err'))}>Cancel preview</button></p> : null;
  return { request, dialog };
}
