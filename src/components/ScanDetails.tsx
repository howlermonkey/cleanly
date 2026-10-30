import type { ScanTask } from '../../shared/types';
import { api } from '../api';
import { useStore } from '../state';

export function ScanDetails({ task }: { task: ScanTask }) {
  const { scanSummaries, activeScans, settings, go, toast } = useStore();
  const summary = scanSummaries[task];
  const running = activeScans.includes(task);
  return <section className="card-w panel" style={{ marginBottom: 16, padding: 16 }} aria-label="Scan scope and results">
    {task !== 'junk' && <p>Scope for scans: {settings?.scanRoots.length ? settings.scanRoots.join(' · ') : 'Desktop, Documents, Downloads, Pictures, Videos and Music'}. {settings?.excludedPaths.length ?? 0} saved exclusions. <button className="btn small" onClick={() => go('settings')}>Edit scan settings</button></p>}
    {running && <button className="btn small" onClick={() => void api.cancelScan(task).catch(e => toast(String(e), 'err'))}>Cancel scan</button>}
    {summary && <details open={summary.cancelled || summary.partial || summary.limited || summary.unreadable > 0}>
      <summary>{running ? 'Previous result: ' : ''}{summary.cancelled ? 'Cancelled — partial results' : summary.partial || summary.limited || summary.unreadable ? 'Partial results' : 'Results within the selected scope'} · {summary.matched} {task === 'dupes' ? 'groups' : task === 'junk' ? 'categories' : 'files'}</summary>
      <p>{summary.visited.toLocaleString()} entries counted · {summary.skipped.toLocaleString()} skipped entries/paths · {summary.unreadable.toLocaleString()} read failures. Skipped folders can contain additional files.</p>
      {summary.notes.map(n => <p key={n}>{n}</p>)}
      <ul>{summary.roots.map(p => <li key={p} style={{ overflowWrap: 'anywhere' }}>{p}</li>)}</ul>
    </details>}
  </section>;
}
