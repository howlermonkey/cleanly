import { ScanDetails } from '../components/ScanDetails';
import { useRemovalPreview } from '../components/RemovalPreview';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DuplicateGroup, IconName } from '../../shared/types';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Progress, ScreenHead } from '../components/ui';
import { formatBytes, formatDate, shortPath, splitBytes, sum } from '../lib/format';
import { useFileIcons } from '../lib/useFileIcons';
import { driveOf, useStore } from '../state';
import './files.css';

const PAGE = 30;

const EXT_ICON: [RegExp, IconName][] = [
  [/\.(mp4|mov|mkv|avi|webm|m4v|wmv)$/i, 'video'],
  [/\.(jpe?g|png|gif|heic|webp|tiff?|bmp|raw|cr2|nef|dng)$/i, 'photo'],
  [/\.(mp3|wav|flac|aac|m4a|ogg)$/i, 'music'],
  [/\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/i, 'layers'],
  [/\.(pdf|docx?|xlsx?|pptx?|txt|rtf|odt|pages|key|numbers|csv)$/i, 'doc'],
  [/\.(dmg|iso|img|exe|msi|pkg)$/i, 'down'],
  [/\.(js|ts|py|json|html|css|java|c|cpp|cs|go|rs)$/i, 'code'],
];

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const parentDir = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
const iconFor = (name: string): IconName => EXT_ICON.find(([re]) => re.test(name))?.[1] ?? 'file';
const newestPath = (g: DuplicateGroup) => g.files.reduce((a, b) => (b.modified > a.modified ? b : a)).path;
const wasted = (g: DuplicateGroup) => g.size * Math.max(0, g.files.length - 1);

// hashing is slow; keep the result while the app is open
let cache: DuplicateGroup[] | null = null;
let cacheKey = '';
let pending: Promise<DuplicateGroup[]> | null = null;
let pendingKey = '';
function scan(key: string): Promise<DuplicateGroup[]> {
  if (pending && pendingKey === key) return pending;
  const previous = pending;
  const promise = (async () => {
    if (previous) { await api.cancelScan('dupes'); await previous.catch(() => undefined); }
    const groups = await api.scanDuplicates();
    cache = groups.filter(g => g.files.length > 1).sort((a,b) => wasted(b) - wasted(a));
    cacheKey = key; return cache;
  })();
  pending = promise; pendingKey = key;
  void promise.finally(() => { if (pending === promise) pending = null; }).catch(() => undefined);
  return promise;
}

export default function Duplicates() {
  const { request: previewRemoval, dialog: removalDialog } = useRemovalPreview();
  const { progress, system, disks, toast, settings } = useStore();
  const scanKey = settings ? JSON.stringify([settings.scanRoots, settings.excludedPaths, settings.duplicateMinBytes, settings.includeHidden]) : '';
  const [retained, setRetained] = useState<Set<string>>(new Set());
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(cacheKey === scanKey ? cache : null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState<Set<string>>(new Set((cacheKey === scanKey ? cache ?? [] : []).map(g => g.hash)));
  const [limit, setLimit] = useState(PAGE);
  const [trashing, setTrashing] = useState(false);

  const home = system?.homeDir;
  const prog = progress?.task === 'dupes' ? progress : null;

  const load = useCallback(
    async (force = false) => {
      if (!scanKey) return;
      if (!force && cache && cacheKey === scanKey) {
        setGroups(cache);
        return;
      }
      if (force) cache = null;
      setGroups(null);
      setLoading(true);
      setFailed(false);
      try {
        const next = await scan(scanKey);
        setGroups(next);
        setKeep({});
        setSkip(new Set(next.map(g => g.hash)));
        setRetained(new Set());
        setLimit(PAGE);
      } catch (e) {
        setFailed(true);
        toast(e instanceof Error ? e.message : 'Could not compare files', 'err');
      } finally {
        setLoading(false);
      }
    },
    [toast, scanKey],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const keeperOf = useCallback((g: DuplicateGroup) => keep[g.hash] ?? newestPath(g), [keep]);

  const toTrash = useMemo(
    () => (groups ?? []).filter((g) => !skip.has(g.hash) && g.files.every(f => f.removalEligible !== false)).flatMap((g) => g.files.filter((f) => f.path !== keeperOf(g) && !retained.has(f.path)).map((f) => ({ path: f.path, size: g.size }))),
    [groups, skip, keeperOf, retained],
  );
  const trashSize = sum(toTrash.map((f) => f.size));
  const totalWasted = sum((groups ?? []).map(wasted));

  const toggleGroup = (hash: string) =>
    setSkip((s) => {
      const n = new Set(s);
      if (n.has(hash)) n.delete(hash);
      else n.add(hash);
      return n;
    });

  const reveal = (path: string) => {
    api.revealPath(path).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not show that file', 'err'));
  };

  const trash = async () => { setTrashing(true);
    try { await previewRemoval(() => api.previewDuplicates((groups ?? []).filter(g => !skip.has(g.hash) && g.files.every(f => f.removalEligible !== false)).map(g => ({ hash: g.hash, keeper: keeperOf(g), remove: g.files.filter(f => f.path !== keeperOf(g) && !retained.has(f.path)).map(f => f.path) })).filter(g => g.remove.length)), () => load(true)); }
    finally { setTrashing(false); }
  };

  const icons = useFileIcons((groups ?? []).slice(0, limit).map((g) => g.files[0]?.path));

  const total = splitBytes(totalWasted);
  const sel = splitBytes(trashSize);
  const n = toTrash.length;

  return (
    <div className="screen">
      {removalDialog}
      <ScanDetails task="dupes" />
      <ScreenHead title="Duplicates" sub="Exact-content matches using whole-file hashes. Select groups explicitly, choose a keeper, and retain any extra copies you want. Removal is disabled.">
        {groups && groups.length > 0 && (
          <div className="fx-stat">
            <span>Wasted</span>
            <div className="fx-big">
              {total.value}
              <small>{total.unit}</small>
            </div>
          </div>
        )}
        <button type="button" className="btn small" onClick={() => void load(true)} disabled={loading || trashing}>
          {loading ? <span className="spinner" /> : <Icon name="scan" />}
          {loading ? 'Comparing' : 'Rescan'}
        </button>
      </ScreenHead>

      {!groups && (
        <section className="card-w rise">
          {failed ? (
            <Empty icon="warning" title="Comparison didn't finish" text="Something got in the way. Give it another try.">
              <button type="button" className="btn primary" onClick={() => void load(true)}>
                Try again
              </button>
            </Empty>
          ) : (
            <div className="fx-wait">
              <span className="orb">
                <Icon name="dupes" />
              </span>
              <h3>Comparing your files</h3>
              <p>{prog?.phase ? `${prog.phase}. ` : ''}We compare file sizes and content hashes. You can cancel the scan or switch screens.</p>
              <Progress value={prog && prog.total > 0 ? prog.done / prog.total : undefined} />
              {prog?.current && <div className="cur">{shortPath(prog.current, home)}</div>}
            </div>
          )}
        </section>
      )}

      {groups && groups.length === 0 && (
        <section className="card-w rise">
          <Empty icon="check" title="No matching duplicates found" text="No matches were found within this scan’s folders, size threshold and exclusions. Review the scan summary for skipped or unreadable paths." />
        </section>
      )}

      {groups && groups.length > 0 && (
        <>
          {loading && (
            <section className="card-w">
              <div className="fx-strip">
                <span className="spinner" />
                <span>{prog?.phase ?? 'Comparing again'}</span>
                <Progress value={prog && prog.total > 0 ? prog.done / prog.total : undefined} />
              </div>
            </section>
          )}
          <p>Select up to 200 groups / 10,000 copies per preview. Custom-folder matches may be discovery-only. <button className="btn small" onClick={() => setSkip(new Set(groups.map(g => g.hash)))}>Select no groups</button></p>
          <div className="fx-groups">
            {groups.slice(0, limit).map((g, i) => {
              const name = baseName(g.files[0].path);
              const keeper = keeperOf(g);
              const newest = newestPath(g);
              const readOnly = g.files.some(f => f.removalEligible === false);
              const off = skip.has(g.hash) || readOnly;
              return (
                <section key={g.hash} className={`card-w fx-group rise${off ? ' skip' : ''}`} style={{ animationDelay: `${Math.min(i, 8) * 0.04}s` }}>
                  <div className="fx-group-head">
                    <input
                      type="checkbox"
                      className="check"
                      checked={!off}
                      disabled={trashing || readOnly}
                      onChange={() => toggleGroup(g.hash)}
                      aria-label={`Include ${name}`}
                    />
                    {icons[g.files[0].path] ? (
                      <span className="chip-ico real">
                        <img src={icons[g.files[0].path]} alt="" draggable={false} />
                      </span>
                    ) : (
                      <span className="chip-ico">
                        <Icon name={iconFor(name)} />
                      </span>
                    )}
                    <div className="grow">
                      <div className="title" title={name}>
                        {name}
                      </div>
                      <div className="sub">
                        {g.files.length} copies · {formatBytes(g.size)} each {readOnly && '· Discovery only'}
                      </div>
                    </div>
                    <div className="fx-wasted">
                      <b>{formatBytes(wasted(g))}</b>
                      <span>wasted</span>
                    </div>
                  </div>
                  <div className="list fx-copies" role="radiogroup" aria-label={`Copy of ${name} to keep`}>
                    {g.files.map((f) => {
                      const kept = f.path === keeper || retained.has(f.path);
                      const drive = driveOf(f.path, home, disks);
                      return (
                        <label key={f.path} className={`row${kept ? ' keep' : ''}`}>
                          <input
                            type="radio"
                            className="fx-radio"
                            name={`keep-${g.hash}`}
                            checked={f.path === keeper}
                            disabled={trashing}
                            onChange={() => setKeep((k) => ({ ...k, [g.hash]: f.path }))}
                            aria-label="Keep this one"
                          />
                          <div className="grow">
                            <div className="title" title={f.path}>
                              {drive ? (
                                <>
                                  <span className="fx-drive">{drive.name}</span>
                                  {drive.dir}
                                </>
                              ) : (
                                shortPath(parentDir(f.path), home)
                              )}
                            </div>
                            <div className="sub">
                              Modified {formatDate(f.modified)}
                              {f.path === newest && ' · newest'}
                            </div>
                          </div>
                          {f.path !== keeper && <button type="button" className="btn small" disabled={trashing || readOnly} onClick={e => { e.preventDefault(); setRetained(r => { const n = new Set(r); if (n.has(f.path)) n.delete(f.path); else n.add(f.path); return n; }); }}>{retained.has(f.path) ? 'Allow preview' : 'Retain this copy'}</button>}
                          <span className={`fx-fate ${kept ? 'keep' : 'trash'}`}>{kept ? 'Keep' : off ? 'Leave' : 'To Trash'}</span>
                          <button
                            type="button"
                            className="icon-btn"
                            title="Show in folder"
                            aria-label="Show in folder"
                            onClick={(e) => {
                              e.preventDefault();
                              reveal(f.path);
                            }}
                          >
                            <Icon name="reveal" />
                          </button>
                        </label>
                      );
                    })}
                  </div>
                </section>
              );
            })}
            {groups.length > limit && (
              <button type="button" className="btn fx-more" onClick={() => setLimit((l) => l + PAGE)}>
                Show {Math.min(PAGE, groups.length - limit)} more of {groups.length - limit}
              </button>
            )}
          </div>

          {n > 0 &&
            (
              <div className="fx-dock">
                <div className="grow">
                  <div className="fx-dock-num">
                    {sel.value}
                    <small>{sel.unit} selected</small>
                  </div>
                  <div className="fx-dock-sub">
                    {groups.length - skip.size} of {groups.length} groups · keeping one copy of each
                  </div>
                </div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={trashing || loading || n > 10000 || (groups.length - skip.size) > 200}
                  onClick={() => void trash()}
                >
                  {trashing ? <span className="spinner" style={{ borderColor: 'rgba(255,255,255,0.35)', borderTopColor: '#fff' }} /> : <Icon name="trash" />}
                  {trashing ? 'Preparing' : `Preview ${n} ${n === 1 ? 'copy' : 'copies'}`}
                </button>
              </div>
            )}
        </>
      )}
    </div>
  );
}
