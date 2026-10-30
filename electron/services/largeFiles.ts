import os from 'node:os';
import path from 'node:path';
import type { LargeFile, ScanProgress } from '../../shared/types';
import { isPersonalPath } from './personalPolicy';
import { discoveryOptions, discoverable, excluded } from './discovery';
import type { ScanSummary } from '../../shared/types';
import { displayPath, isInside, localAppData, walk, incompleteWalk, type WalkFile } from './walk';

type Progress = (p: ScanProgress) => void;
type Kind = LargeFile['kind'];

const MAX_RESULTS = 300;
const MAX_ENTRIES = 2_000_000;
const MB = 1024 * 1024;

const KINDS: Record<Exclude<Kind, 'other'>, string[]> = {
  video: ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'm2ts', 'mts', 'vob', 'prproj'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz', 'lzma', 'cab'],
  'disk-image': ['iso', 'img', 'dmg', 'vhd', 'vhdx', 'vmdk', 'vdi', 'qcow2', 'wim', 'esd', 'sparseimage', 'hdd'],
  installer: ['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'pkg', 'mpkg', 'deb', 'rpm', 'apk', 'xapk', 'appimage'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'wma', 'aiff', 'aif', 'opus', 'alac', 'mid'],
  photo: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'psd', 'psb', 'webp', 'avif', 'orf', 'rw2', 'raf'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'csv', 'epub', 'mobi', 'pages', 'numbers', 'key', 'indd', 'ai', 'sketch', 'fig'],
};

const EXT_KIND = new Map<string, Kind>();
for (const [kind, exts] of Object.entries(KINDS) as [Kind, string[]][]) for (const e of exts) EXT_KIND.set(e, kind);

export function kindOf(name: string): Kind {
  return EXT_KIND.get(path.extname(name).slice(1).toLowerCase()) ?? 'other';
}

// Regenerable caches are the junk scanner's job; they only add noise here.
const CACHE_DIRS = new Set([
  'cache', 'caches', 'code cache', 'gpucache', 'cache_data', 'cache2', 'cachestorage', 'scriptcache', 'shadercache', 'grshadercache',
]);

const TOTAL_ENTRIES = 4_000_000;

/** Biggest ordinary files in the OS-known personal folders, at least minBytes each. */
export async function scanLargeFiles(minBytes: unknown, progress: Progress, options = discoveryOptions(), signal?: AbortSignal): Promise<LargeFile[]> {
  const summary: ScanSummary = { roots: options.roots, visited: 0, skipped: 0, unreadable: 0, matched: 0, limited: false, cancelled: false,
    notes: ['Largest 300 matching files. Protected paths and links excluded. Extra folders are discovery-only.', options.exclusions.length + ' saved exclusions. Hidden names ' + (options.includeHidden ? 'included.' : 'excluded.')] };
  const n = Number(minBytes);
  const min = Number.isFinite(n) && n >= MB ? n : 100 * MB;
  const home = os.homedir();
  const appData = process.platform === 'darwin' ? path.join(home, 'Library') : path.join(home, 'AppData');
  const skipExact = [
    path.join(localAppData(), 'Temp'),
    os.tmpdir(),
    path.join(home, 'Library', 'Caches'),
    path.join(home, '.Trash'),
    path.join(home, '.cache'),
  ];

  // walk hands out resolved paths, so a lowercase lookup is enough on the case-insensitive desktop file systems
  const skipSet = new Set(skipExact.map((s) => path.resolve(s).toLowerCase()));

  let found: LargeFile[] = [];
  let limited = false;
  const trim = () => {
    if (found.length > MAX_RESULTS) limited = true;
    found.sort((a, b) => b.size - a.size);
    found = found.slice(0, MAX_RESULTS);
  };
  let last = 0;
  let seen = 0;
  const homePhase = 'Looking for large files';
  progress({ task: 'large', phase: homePhase, done: 0, total: 0 });

  const collect = (f: WalkFile) => {
    if (f.size < min || !discoverable(f.path, options) || (!options.includeHidden && f.name.startsWith('.'))) { summary.skipped++; return; }
    found.push({ path: f.path, name: f.name, size: f.size, modified: f.mtimeMs, accessed: f.atimeMs, kind: kindOf(f.name), removalEligible: isPersonalPath(f.path) });
    if (found.length > MAX_RESULTS * 10) trim();
  };
  const ticker = (phase: string) => (entries: number, current: string) => {
    const now = Date.now();
    if (now - last < 120) return;
    last = now;
    progress({ task: 'large', phase, done: seen + entries, total: 0, current: displayPath(current) });
  };

  const roots = options.roots;
  for (const root of roots) {
    if (signal?.aborted) break;
    if (excluded(root, options.exclusions)) { summary.skipped++; continue; }
    const budget = Math.min(MAX_ENTRIES, TOTAL_ENTRIES - seen);
    if (budget <= 0) { limited = true; break; }
    const stats = await walk(root, {
      maxEntries: budget,
      signal,
      skipDir: (p, name) => {
        const skip = !discoverable(p, options) || (!options.includeHidden && name.startsWith('.')) || skipSet.has(p.toLowerCase()) || (CACHE_DIRS.has(name.toLowerCase()) && isInside(appData,p));
        if (skip) summary.skipped++;
        return skip;
      },
      onFile: collect,
      onTick: ticker(homePhase),
    });
    if (incompleteWalk(stats)) limited = true;
    summary.unreadable += stats.unreadable;
    summary.skipped += stats.linked;
    seen += stats.files + stats.dirs;
  }

  trim();
  Object.assign(summary, { visited: seen, matched: found.length, limited, cancelled: Boolean(signal?.aborted) });
  progress({ task: 'large', phase: signal?.aborted ? 'Cancelled' : 'Done', done: found.length, total: found.length, summary, warning: limited || signal?.aborted ? 'Large Files is partial: inaccessible paths, cancellation or scan/result limits.' : '' });
  return found;
}
