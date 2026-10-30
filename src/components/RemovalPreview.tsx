import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { DESTRUCTIVE_FEATURES_ENABLED, SAFETY_NOTICE } from '../../shared/safety';
import type { RemovalPlan } from '../../shared/types';
import { formatBytes } from '../lib/format';
import { useStore } from '../state';

export function useRemovalPreview() {
  const [plan, setPlan] = useState<RemovalPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const region = useRef<HTMLElement>(null);
  useEffect(() => { if (plan) region.current?.scrollIntoView({ block: 'start' }); }, [plan]);
  const after = useRef<(() => Promise<void>) | undefined>(undefined);
  const { toast, refreshDisk, smartScan } = useStore();
  const request = async (prepare: () => Promise<RemovalPlan>, onComplete?: () => Promise<void>) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setPlan(null);
    try { setPlan(await prepare()); after.current = onComplete; }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not prepare a complete preview', 'err'); }
    finally { active.current = false; setBusy(false); }
  };
  const execute = async () => {
    if (!DESTRUCTIVE_FEATURES_ENABLED || !plan || active.current) return;
    active.current = true;
    setBusy(true);
    try {
      const result = await api.executePlan(plan.id);
      setPlan(null);
      toast(`${result.removed} items removed; ${formatBytes(result.movedToTrash ?? 0)} moved to Trash. ${result.failed} failed. Free space is remeasured.`, result.failed ? 'err' : 'ok');
      await Promise.all([refreshDisk(), smartScan(), after.current?.()]);
    } catch (e) {
      setPlan(null); // Tokens are single-use even when preflight fails.
      toast(e instanceof Error ? e.message : 'Removal stopped; preview again', 'err');
    } finally { active.current = false; setBusy(false); }
  };
  const dialog = plan ? (
    <section ref={region} className="card-w panel" role="region" aria-label="Removal preview" style={{ padding: 20, marginTop: 16 }}>
      <h2>Removal preview · {plan.items.length} items</h2>
      <p>No files have been changed. This selection expires in five minutes. Changed or unavailable files invalidate approval.</p>
      <div style={{ maxHeight: 360, overflow: 'auto' }} tabIndex={0} aria-label="All selected paths">
        <ul>{plan.items.map(i => <li key={i.path} style={{ overflowWrap: 'anywhere' }}><b>{i.action === 'delete' ? 'Permanent deletion' : 'Move to Trash'}</b> · {formatBytes(i.size)}<br />{i.path}</li>)}</ul>
      </div>
      {!DESTRUCTIVE_FEATURES_ENABLED && <p>{SAFETY_NOTICE}</p>}
      <button type="button" className="btn" onClick={() => setPlan(null)} disabled={busy}>Close preview</button>{' '}
      <button type="button" className="btn danger" disabled={!DESTRUCTIVE_FEATURES_ENABLED || busy || Date.now() >= plan.expiresAt} onClick={() => void execute()}>Confirm removal</button>
    </section>
  ) : busy ? <p role="status">Preparing an exact preview. Nothing is being removed.</p> : null;
  return { request, dialog };
}
