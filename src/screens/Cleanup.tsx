import { api } from '../api';
import { useRemovalPreview } from '../components/RemovalPreview';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JunkCategory } from '../../shared/types';
import { Icon } from '../components/Icon';
import { CleanButton, Empty, Progress, ScreenHead } from '../components/ui';
import { formatBytes, shortPath, splitBytes, sum } from '../lib/format';
import { useStore } from '../state';
import './files.css';

const isPermanent = (c: JunkCategory) => /recycle|trash/i.test(`${c.id} ${c.name}`);

export default function Cleanup() {
  const { request: previewRemoval, dialog: removalDialog } = useRemovalPreview();
  const { junk, scanning, smartScan, progress, cleaning, system } = useStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // scan once on arrival; a failed scan leaves the retry button below instead of looping
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || junk || scanning) return;
    asked.current = true;
    void smartScan();
  }, [junk, scanning, smartScan]);

  // a fresh scan result resets the selection to the safe categories
  useEffect(() => {
    setSelected(new Set((junk ?? []).filter((c) => c.safe && c.size > 0).map((c) => c.id)));
  }, [junk]);

  const items = useMemo(() => [...(junk ?? [])].sort((a, b) => Number(b.safe) - Number(a.safe) || b.size - a.size), [junk]);
  const chosen = items.filter((c) => selected.has(c.id) && c.size > 0);
  const total = sum(chosen.map((c) => c.size));
  const files = sum(chosen.map((c) => c.count));
  const cleanable = items.filter((c) => c.size > 0);
  const allOn = cleanable.length > 0 && cleanable.every((c) => selected.has(c.id));
  const home = system?.homeDir;
  const scanProg = progress?.task === 'junk' ? progress : null;
  const cleanProg = progress?.task === 'clean' ? progress : null;

  const toggle = (id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const toggleAll = () => setSelected(allOn ? new Set() : new Set(cleanable.map((c) => c.id)));

  const run = () => previewRemoval(() => api.previewJunk(chosen.map(c => c.id)));
  const start = () => { if (chosen.length) void run(); };

  const big = splitBytes(total);

  return (
    <div className="screen">
      {removalDialog}
      <ScreenHead title="Cleanup" sub="Inspect cleanup candidates and preview exact paths. Removal is disabled in this development build.">
        <div className="fx-head-actions">
          <button type="button" className="btn small" onClick={() => void smartScan()} disabled={scanning || cleaning}>
            {scanning ? <span className="spinner" /> : <Icon name="scan" />}
            {scanning ? 'Scanning' : 'Rescan'}
          </button>
        </div>
      </ScreenHead>

      {!junk && scanning && (
        <section className="card-w rise">
          <div className="fx-wait">
            <span className="orb">
              <Icon name="broom" />
            </span>
            <h3>Looking for junk</h3>
            <p>{scanProg?.phase ?? 'Checking caches, temp folders and logs'}</p>
            <Progress value={scanProg && scanProg.total > 0 ? scanProg.done / scanProg.total : undefined} />
            {scanProg?.current && <div className="cur">{shortPath(scanProg.current, home)}</div>}
          </div>
        </section>
      )}

      {!junk && !scanning && (
        <section className="card-w rise">
          <Empty icon="scan" title="No scan yet" text="Run a quick scan to see what can be cleaned.">
            <button type="button" className="btn primary" onClick={() => void smartScan()}>
              <Icon name="scan" /> Scan now
            </button>
          </Empty>
        </section>
      )}

      {junk && (
        <section className="card-w fx-panel rise" style={{ animationDelay: '0.06s' }}>
          {scanning && (
            <div className="fx-strip">
              <span className="spinner" />
              <span>{scanProg?.phase ?? 'Rescanning'}</span>
              <Progress value={scanProg && scanProg.total > 0 ? scanProg.done / scanProg.total : undefined} />
            </div>
          )}
          <div className="fx-panel-head">
            <h2>What we found</h2>
            <span className="fx-count">
              {cleanable.length} of {items.length} have something to clean
            </span>
            <span className="grow" />
            <button type="button" className="fx-link" onClick={toggleAll} disabled={!cleanable.length || cleaning}>
              {allOn ? 'Select none' : 'Select all'}
            </button>
          </div>
          {cleanable.length === 0 && !scanning ? (
            <Empty icon="check" title="No candidates found" text="No candidates were found in the inspected locations. Check scan warnings for excluded or unreadable locations." />
          ) : (
            <div className="list fx-list">
              {items.map((c) => {
                const empty = c.size <= 0;
                const on = selected.has(c.id) && !empty;
                const perm = isPermanent(c);
                return (
                  <label key={c.id} className={`row${on ? ' on' : ''}${empty ? ' off' : ''}`}>
                    <input type="checkbox" className="check" checked={on} disabled={empty || cleaning} onChange={() => toggle(c.id)} aria-label={c.name} />
                    <span className={`chip-ico${perm ? ' warm' : c.safe ? '' : ' mute'}`}>
                      <Icon name={c.icon} />
                    </span>
                    <div className="grow">
                      <div className="title">{c.name}</div>
                      <div className="fx-desc">{c.description}</div>
                      <div className="sub mono" title={c.locations.join('\n')}>
                        {c.locations.map((l) => shortPath(l, home)).join('  ·  ')}
                      </div>
                    </div>
                    <div className="tags">
                      {perm && (
                        <span className="tag keep">
                          <Icon name="warning" />
                          Permanent
                        </span>
                      )}
                      {!empty && <span className={`tag ${c.safe ? 'safe' : 'review'}`}>{c.safe ? 'Suggested' : 'Review'}</span>}
                    </div>
                    <span className="size">{empty ? 'Clean' : formatBytes(c.size)}</span>
                  </label>
                );
              })}
            </div>
          )}
        </section>
      )}

      {junk && cleanable.length > 0 && (
          <div className="fx-dock">
            <div className="grow">
              <div className="fx-dock-num">
                {big.value}
                <small>{big.unit} selected</small>
              </div>
              <div className="fx-dock-sub">
                {cleaning
                  ? cleanProg?.phase ?? 'Cleaning'
                  : `${chosen.length} ${chosen.length === 1 ? 'category' : 'categories'} · ${files.toLocaleString()} items`}
              </div>
            </div>
            {cleaning && <Progress value={cleanProg && cleanProg.total > 0 ? cleanProg.done / cleanProg.total : undefined} />}
            <CleanButton
              label={cleaning ? 'Working' : 'Preview cleanup'}
              sub={formatBytes(total)}
              busy={cleaning}
              disabled={!chosen.length || scanning}
              onClick={start}
            />
          </div>
      )}
    </div>
  );
}
