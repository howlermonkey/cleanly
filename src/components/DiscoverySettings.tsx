import { useState } from 'react';
import { api, isDemo } from '../api';
import { useStore } from '../state';
import type { Settings } from '../../shared/types';

export function DiscoverySettings() {
  const { settings, updateSettings, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const [ignore, setIgnore] = useState('');
  if (!settings) return null;
  const save = async (patch: Partial<Settings>) => {
    setBusy(true);
    try { await updateSettings(patch); }
    catch (e) { toast(e instanceof Error ? e.message : 'Settings could not be saved', 'err'); }
    finally { setBusy(false); }
  };
  const addFolder = async () => {
    setBusy(true);
    try {
      const folder = await api.chooseFolder();
      if (folder) await updateSettings({ scanRoots: [...new Set([...settings.scanRoots, folder])] });
    } catch (e) { toast(e instanceof Error ? e.message : 'Folder unavailable', 'err'); }
    finally { setBusy(false); }
  };
  return <section className="card-w panel sy-wide" aria-label="Discovery settings">
    <h2>Scan folders and exclusions</h2>
    <p>These settings apply to Duplicates and Large Files. Additional folders are read-only discovery locations; removal permissions do not change.</p>
    <p>{settings.scanRoots.length ? 'Only the custom folders below will be scanned.' : 'Using Desktop, Documents, Downloads, Pictures, Videos and Music, including OS-known folder redirection.'}</p>
    <ul>{settings.scanRoots.map(p => <li key={p} style={{ overflowWrap: 'anywhere', marginBottom: 8 }}>{p} <button className="btn small" disabled={busy} onClick={() => void save({ scanRoots: settings.scanRoots.filter(r => r !== p) })}>Remove folder</button></li>)}</ul>
    <button className="btn small" disabled={busy || isDemo} onClick={() => void addFolder()}>Choose scan folder</button>{' '}
    <button className="btn small" disabled={busy || !settings.scanRoots.length} onClick={() => void save({ scanRoots: [] })}>Use default folders</button>
    {isDemo && <p>Folder selection is available in the desktop app. This browser uses synthetic demo data.</p>}
    <div className="sy-opt"><label>Minimum duplicate file size{' '}<select className="input" disabled={busy} value={settings.duplicateMinBytes} onChange={e => void save({ duplicateMinBytes: Number(e.target.value) })}>
      {[1, 1024, 1024 ** 2, 10 * 1024 ** 2, 100 * 1024 ** 2].map(n => <option key={n} value={n}>{n === 1 ? 'All non-empty files' : n === 1024 ? '1 KB' : `${n / 1024 ** 2} MB`}</option>)}
    </select></label></div>
    <label className="sy-opt"><input type="checkbox" checked={settings.includeHidden} disabled={busy} onChange={e => void save({ includeHidden: e.target.checked })} /> Include names beginning with a dot. Protected app and credential paths remain excluded.</label>
    <h3>Saved exclusions</h3>
    <p>Exact file or folder paths, including descendants. These exclusions also apply to cleanup scans and new cleanup batches. Wildcards are not used.</p>
    <ul>{settings.excludedPaths.map(p => <li key={p} style={{ overflowWrap: 'anywhere', marginBottom: 8 }}>{p} <button className="btn small" disabled={busy} onClick={() => void save({ excludedPaths: settings.excludedPaths.filter(r => r !== p) })}>Remove exclusion</button></li>)}</ul>
    <label>File or folder to ignore <input className="input" aria-label="Path to exclude" value={ignore} onChange={e => setIgnore(e.target.value)} placeholder="Full local path" /></label>{' '}
    <button className="btn small" disabled={busy || !ignore.trim()} onClick={() => { void save({ excludedPaths: [...new Set([...settings.excludedPaths, ignore.trim()])] }); }}>Save exclusion</button>
    <p>Changes apply to the next scan. Cleanup locations remain restricted to known cache categories.</p>
  </section>;
}
