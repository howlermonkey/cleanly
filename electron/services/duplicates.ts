import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { isPersonalPath } from './personalPolicy';
import { discoveryOptions, discoverable, excluded } from './discovery';
import { checkCancelled } from './scanJobs';
import { assertNoLinks } from './pathSafety';
import type { DiscoveryOptions, DuplicateGroup, ScanProgress, ScanSummary } from '../../shared/types';

type Progress = (p: ScanProgress) => void;

interface Entry {
  path: string;
  size: number;
  modified: number;
}

const EDGE = 64 * 1024;
const MAX_FILES = 400_000;

// Hidden folders, dependency trees and macOS packages (Photos/Music libraries, apps)
// hold files the user does not manage directly; removing a "duplicate" inside them breaks the package.
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', '__pycache__', 'bower_components']);
const PACKAGE_EXT = /\.(app|photoslibrary|photolibrary|musiclibrary|tvlibrary|imovielibrary|fcpbundle|logicx|band|aplibrary|lrdata|lrlibrary|bundle|framework|plugin|kext|xcodeproj|xcworkspace|pkg|mpkg|sparsebundle|rtfd|pages|numbers|key|vmwarevm|pvm|utm)$/i;


function throttle(progress: Progress): Progress {
  let last = 0;
  return (p) => {
    const now = Date.now();
    if (now - last < 120 && p.done !== p.total) return;
    last = now;
    progress(p);
  };
}

async function walk(options: DiscoveryOptions, summary: ScanSummary, signal: AbortSignal | undefined, report: (seen: number, dir: string) => void): Promise<{ files: Entry[]; incomplete: boolean }> {
  let incomplete = false;
  const files: Entry[] = [];
  const seenInodes = new Set<string>();
  const queue: string[] = [];
  for (const root of options.roots) {
    if (signal?.aborted) break;
    if (excluded(root, options.exclusions)) { summary.skipped++; continue; }
    try {
      await assertNoLinks(root);
      const st = await fs.lstat(root);
      if (st.isDirectory() && !st.isSymbolicLink()) queue.push(root);
    } catch {
      incomplete = true;
      summary.unreadable++;
    }
  }
  let seen = 0;
  let visited = 0;
  let active = 0;

  await new Promise<void>((resolve) => {
    const pump = () => {
      if ((queue.length === 0 || signal?.aborted) && active === 0) {
        resolve();
        return;
      }
      while (!signal?.aborted && active < 16 && queue.length > 0 && visited < MAX_FILES) {
        const dir = queue.pop()!;
        active++;
        visit(dir).catch(() => { incomplete = true; }).finally(() => {
          active--;
          pump();
        });
      }
      if (visited >= MAX_FILES && active === 0) { summary.limited = true; incomplete = true; resolve(); }
    };

    const visit = async (dir: string) => {
      let names: string[];
      try {
        await assertNoLinks(dir);
        names = await fs.readdir(dir);
      } catch {
        incomplete = true;
        summary.unreadable++;
        return;
      }
      report(seen, dir);
      for (const name of names) {
        if (signal?.aborted) break;
        if (visited++ >= MAX_FILES) { incomplete = true; break; }
        if (!options.includeHidden && name.startsWith('.')) { summary.skipped++; continue; }
        const full = path.join(dir, name);
        if (!discoverable(full, options)) { summary.skipped++; continue; }
        // bigint keeps NTFS 64-bit file ids exact; as plain numbers distinct files could share an id.
        let st: import('node:fs').BigIntStats;
        try {
          st = await fs.lstat(full, { bigint: true });
        } catch {
          incomplete = true;
          summary.unreadable++;
          continue;
        }
        // lstat reports symlinks and Windows junctions as links; never follow them.
        if (st.isSymbolicLink()) { summary.skipped++; incomplete = true; continue; }
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(name.toLowerCase()) && !PACKAGE_EXT.test(name)) queue.push(full);
          continue;
        }
        if (!st.isFile()) continue;
        seen++;
        const size = Number(st.size);
        if (size < options.minBytes) { summary.skipped++; continue; }
        // macOS iCloud "dataless" files have no local blocks; reading them would download them.
        if (process.platform === 'darwin' && st.blocks === 0n) { summary.skipped++; continue; }
        // Hard links, or one file reached through two scan roots, share storage: a second name is not a
        // real copy, and offering it for the Trash would remove the only copy.
        if (st.ino) {
          const key = `${st.dev}:${st.ino}`;
          if (seenInodes.has(key)) { summary.skipped++; continue; }
          seenInodes.add(key);
        }
        files.push({ path: full, size, modified: Math.round(Number(st.mtimeMs)) });
      }
    };

    pump();
  });
  summary.visited = Math.min(visited, MAX_FILES);
  return { files, incomplete };
}

/**
 * Cloud placeholders (OneDrive, Dropbox, iCloud for Windows) look like normal files but
 * reading them downloads the whole file. Windows marks them with recall/offline attributes.
 */
function windowsLocalOnly(entries: Entry[], signal?: AbortSignal): Promise<Entry[]> {
  if (signal?.aborted) return Promise.resolve([]);
  if (process.platform !== 'win32' || entries.length === 0) return Promise.resolve(entries);
  const script = [
    '[Console]::InputEncoding = [Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$paths = [Console]::In.ReadToEnd() -split "`n"',
    'foreach ($p in $paths) { if ($p) { try { [int][IO.File]::GetAttributes($p.TrimEnd("`r")) } catch { -1 } } }',
  ].join('; ');
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      const attrs = out.split(/\r?\n/).filter((l) => l.trim() !== '').map(Number);
      // If we cannot tell, skip everything rather than risk pulling files from the cloud.
      if (!ok || attrs.length !== entries.length) {
        resolve([]);
        return;
      }
      const CLOUD = 0x1000 | 0x40000 | 0x400000; // OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS
      resolve(entries.filter((_, i) => attrs[i] >= 0 && (attrs[i] & CLOUD) === 0));
    };
    const child = spawn(path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 60000);
    const cancel = () => { child.kill(); finish(false); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
    });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
    child.stdin.on('error', () => undefined);
    child.stdin.end(entries.map((e) => e.path).join('\n'), 'utf8');
  });
}

async function partialHash(e: Entry, signal?: AbortSignal): Promise<string | null> {
  let fh: import('node:fs/promises').FileHandle | null = null;
  try {
    checkCancelled(signal);
    await assertNoLinks(e.path);
    fh = await fs.open(e.path, 'r');
    const head = Buffer.alloc(EDGE);
    const tail = Buffer.alloc(EDGE);
    const a = await fh.read(head, 0, EDGE, 0);
    const b = await fh.read(tail, 0, EDGE, Math.max(0, e.size - EDGE));
    checkCancelled(signal);
    return createHash('sha1').update(head.subarray(0, a.bytesRead)).update(tail.subarray(0, b.bytesRead)).digest('hex');
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

async function fullHash(e: Entry, signal?: AbortSignal): Promise<string | null> {
  try { checkCancelled(signal); await assertNoLinks(e.path); } catch { return null; }
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    const stream = createReadStream(e.path, { highWaterMark: 1024 * 1024, signal });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (!signal?.aborted && next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function groupBy<K>(entries: Entry[], keys: (K | null)[]): [K, Entry[]][] {
  const map = new Map<K, Entry[]>();
  entries.forEach((e, i) => {
    const k = keys[i];
    if (k == null) return;
    const list = map.get(k);
    if (list) list.push(e);
    else map.set(k, [e]);
  });
  return [...map.entries()].filter(([, g]) => g.length > 1);
}

export async function scanDuplicates(progress: Progress, options = discoveryOptions(), signal?: AbortSignal): Promise<DuplicateGroup[]> {
  const summary: ScanSummary = { roots: options.roots, visited: 0, skipped: 0, unreadable: 0, matched: 0, limited: false, cancelled: false,
    notes: [`Minimum file size: ${options.minBytes} bytes. ${options.includeHidden ? 'Hidden names included' : 'Hidden names excluded'}. Protected paths, links, hardlinks and cloud-only files are excluded.`, `${options.exclusions.length} saved exclusions. Extra folders are discovery-only; removal permissions are unchanged.`] };
  const send = throttle(progress);
  send({ task: 'dupes', phase: 'Looking for files', done: 0, total: 0 });
  const scanned = await walk(options, summary, signal, (seen, dir) =>
    send({ task: 'dupes', phase: 'Looking for files', done: seen, total: 0, current: dir }));

  const files = scanned.files;
  // Only files sharing an exact size can be duplicates.
  const bySize = groupBy(files, files.map((f) => f.size));
  const candidates = bySize.flatMap(([, g]) => g);
  const sizeCandidates = await windowsLocalOnly(candidates, signal);
  summary.skipped += candidates.length - sizeCandidates.length;

  let done = 0;
  const partialTotal = sizeCandidates.length;
  const partialKeys = await mapLimit(sizeCandidates, 6, async (e) => {
    const h = await partialHash(e, signal);
    send({ task: 'dupes', phase: 'Comparing files', done: ++done, total: partialTotal, current: e.path });
    return h === null ? null : `${e.size}:${h}`;
  }, signal);
  const partialGroups = groupBy(sizeCandidates, partialKeys);

  const fullCandidates = partialGroups.flatMap(([, g]) => g);
  done = 0;
  const fullKeys = await mapLimit(fullCandidates, 4, async (e) => {
    const h = await fullHash(e, signal);
    send({ task: 'dupes', phase: 'Checking contents', done: ++done, total: fullCandidates.length, current: e.path });
    return h;
  }, signal);

  // sha256 over the whole content: equal hashes with equal sizes are byte-identical files.
  const groups: DuplicateGroup[] = groupBy(fullCandidates, fullKeys).map(([hash, g]) => ({
    hash,
    size: g[0].size,
    files: g.map((f) => ({ path: f.path, modified: f.modified, removalEligible: isPersonalPath(f.path) })).sort((a, b) => b.modified - a.modified),
  }));
  groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));
  summary.cancelled = Boolean(signal?.aborted);
  summary.matched = groups.length;
  summary.unreadable += partialKeys.filter(k => k === null).length + fullKeys.filter(k => k === null).length;
  const partial = summary.cancelled || summary.limited || scanned.incomplete || summary.unreadable > 0 || sizeCandidates.length < candidates.length;
  summary.partial = partial;
  progress({ task: 'dupes', phase: summary.cancelled ? 'Cancelled' : 'Done', done: groups.length, total: groups.length, summary,
    warning: partial ? 'Duplicate results are partial. Review the scan summary for cancellation, limits and skipped paths.' : '' });
  return groups;
}
