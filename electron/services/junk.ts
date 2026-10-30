import { execFile } from 'node:child_process';
import { assertDestructiveFeaturesEnabled } from '../../shared/safety';
import { promises as fsp, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CleanResult, IconName, JunkCategory, ScanProgress, ScanSummary } from '../../shared/types';
import { isSafeUserPath } from './trash';
import { assertNoLinks } from './pathSafety';
import { excluded as excludedPath } from './discovery';
import { isInside } from './pathSafety';
import { checkCancelled } from './scanJobs';
import { startCleanupBatches, nextCleanupBatch, type CleanupCandidate } from './cleanupBatches';
import type { RemovalPlan } from '../../shared/types';
import {
  DAY_MS,
  displayPath,
  isRealDir,
  knownFolder,
  mapLimit,
  samePath,
  walk,
  incompleteWalk,
} from './walk';

type Progress = (p: ScanProgress) => void;

interface Root {
  path: string;
  /** Entry names directly in this root that belong to another category. */
  exclude?: string[];
}

interface Def {
  id: string;
  name: string;
  description: string;
  icon: IconName;
  safe: boolean;
  kind: 'cache' | 'downloads' | 'recycle';
  roots?: () => Promise<Root[]>;
  /** Keep files modified after this moment (fresh temp files may belong to running apps). */
  keepNewerThanMs?: number;
  /** Shown when nothing could be removed because of permissions. */
  adminNote?: string;
}

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const OLD_DOWNLOAD_MS = 90 * DAY_MS;
const SCAN_CAP = 1_500_000;
const DOWNLOAD_IGNORE = new Set(['desktop.ini', 'thumbs.db', '.ds_store', '.localized']);

const home = () => os.homedir();
const lib = (...p: string[]) => path.join(home(), 'Library', ...p);

async function dirs(paths: string[], exclude?: (p: string) => string[] | undefined): Promise<Root[]> {
  const out: Root[] = [];
  for (const p of paths) {
    if (out.some((r) => samePath(r.path, p))) continue;
    if (await isRealDir(p)) {
      await assertNoLinks(p);
      out.push({ path: p, exclude: exclude?.(p) });
    }
  }
  return out;
}

async function subdirs(p: string): Promise<string[]> {
  try {
    const list = await fsp.readdir(p, { withFileTypes: true });
    return list.filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
  } catch {
    return [];
  }
}

const PROFILE_CACHES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  path.join('Service Worker', 'ScriptCache'),
];
const USER_DATA_CACHES = ['GrShaderCache', 'ShaderCache', 'GraphiteDawnCache'];
const isProfileName = (n: string) => /^(Default|Profile \d+|Guest Profile|System Profile)$/i.test(n);

/** Cache folders of every profile of a Chromium "User Data" folder. */
async function chromiumCaches(userData: string): Promise<string[]> {
  if (!(await isRealDir(userData))) return [];
  const out = USER_DATA_CACHES.map((c) => path.join(userData, c));
  for (const profile of await subdirs(userData)) {
    if (isProfileName(path.basename(profile))) out.push(...PROFILE_CACHES.map((c) => path.join(profile, c)));
  }
  return out;
}

/** Opera keeps a single profile directly in its folder. */
const profileCaches = (profileDir: string) => PROFILE_CACHES.map((c) => path.join(profileDir, c));

async function firefoxCaches(profilesDir: string): Promise<string[]> {
  return (await subdirs(profilesDir)).map((p) => path.join(p, 'cache2'));
}

/** Only the conventional per-user temp location is eligible for a development preview. */
export function userTempDir(): string {
  // Custom TEMP/LOCALAPPDATA values are not proof that a directory is disposable.
  return path.join(home(), 'AppData', 'Local', 'Temp');
}

function winDefs(): Def[] {
  // Environment overrides do not establish a disposable storage boundary.
  const L = path.join(home(), 'AppData', 'Local');
  const R = path.join(home(), 'AppData', 'Roaming');
  const winDir = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const appCache = (base: string) => ['Cache', 'Code Cache', 'GPUCache'].map((c) => path.join(base, c));

  return [
    {
      id: 'win-temp',
      name: 'Temporary files',
      description: 'Leftovers from installers and apps. Anything touched in the last day is kept.',
      icon: 'file',
      safe: true,
      kind: 'cache',
      keepNewerThanMs: DAY_MS,
      roots: () => dirs([userTempDir()]),
    },
    {
      id: 'win-system-temp',
      name: 'Windows temp',
      description: 'System-wide temporary files. Files Windows still uses are skipped.',
      icon: 'gear',
      safe: true,
      kind: 'cache',
      keepNewerThanMs: DAY_MS,
      roots: () => dirs([path.join(winDir, 'Temp')]),
    },
    {
      id: 'browser-cache',
      name: 'Browser caches',
      description: 'Chrome, Edge, Firefox and others rebuild these as you browse. Logins and history stay.',
      icon: 'globe',
      safe: true,
      kind: 'cache',
      roots: async () => {
        const userDatas = [
          path.join(L, 'Google', 'Chrome', 'User Data'),
          path.join(L, 'Microsoft', 'Edge', 'User Data'),
          path.join(L, 'BraveSoftware', 'Brave-Browser', 'User Data'),
          path.join(L, 'Vivaldi', 'User Data'),
        ];
        const paths: string[] = [];
        for (const u of userDatas) paths.push(...(await chromiumCaches(u)));
        for (const opera of ['Opera Stable', 'Opera GX Stable']) {
          paths.push(...profileCaches(path.join(L, 'Opera Software', opera)));
          paths.push(...profileCaches(path.join(R, 'Opera Software', opera)));
        }
        paths.push(...(await firefoxCaches(path.join(L, 'Mozilla', 'Firefox', 'Profiles'))));
        return dirs(paths);
      },
    },
    {
      id: 'app-cache',
      name: 'App caches',
      description: 'Discord, Slack, Teams, Spotify, VS Code and Zoom rebuild these on their own.',
      icon: 'apps',
      safe: true,
      kind: 'cache',
      roots: () => {
        const teamsNew = path.join(L, 'Packages', 'MSTeams_8wekyb3d8bbwe', 'LocalCache', 'Microsoft', 'MSTeams', 'EBWebView', 'Default');
        return dirs([
          ...appCache(path.join(R, 'discord')),
          ...appCache(path.join(R, 'Slack')),
          ...appCache(path.join(R, 'Microsoft', 'Teams')),
          path.join(R, 'Microsoft', 'Teams', 'tmp'),
          ...appCache(teamsNew),
          path.join(L, 'Spotify', 'Data'),
          path.join(L, 'Packages', 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0', 'LocalCache', 'Spotify', 'Data'),
          ...appCache(path.join(R, 'Code')),
          path.join(R, 'Code', 'CachedData'),
          path.join(R, 'Code', 'CachedExtensionVSIXs'),
          path.join(R, 'Zoom', 'logs'),
        ]);
      },
    },
    {
      id: 'crash-reports',
      name: 'Crash dumps & error reports',
      description: 'Memory dumps and error reports apps left behind after a crash.',
      icon: 'warning',
      safe: true,
      kind: 'cache',
      roots: () =>
        dirs([
          path.join(L, 'CrashDumps'),
          path.join(L, 'Microsoft', 'Windows', 'WER', 'ReportArchive'),
          path.join(L, 'Microsoft', 'Windows', 'WER', 'ReportQueue'),
        ]),
    },
    {
      id: 'win-update',
      name: 'Windows Update downloads',
      description: 'Update installers Windows already used. Removing them needs admin rights.',
      icon: 'history',
      safe: false,
      kind: 'cache',
      adminNote: 'Windows Update files need admin rights, so they were skipped',
      roots: () => dirs([path.join(winDir, 'SoftwareDistribution', 'Download')]),
    },
    {
      id: 'dev-cache',
      name: 'Developer caches',
      description: 'npm, pip, Yarn, pnpm and Gradle caches. The next install downloads packages again.',
      icon: 'code',
      safe: false,
      kind: 'cache',
      roots: () =>
        dirs([
          path.join(L, 'npm-cache'),
          path.join(R, 'npm-cache'),
          path.join(L, 'pip', 'cache'),
          path.join(L, 'Yarn', 'Cache'),
          path.join(L, 'pnpm', 'store'),
          path.join(L, 'pnpm-store'),
          path.join(home(), '.gradle', 'caches'),
        ]),
    },
    {
      id: 'recycle-bin',
      name: 'Recycle Bin',
      description: 'Files you already deleted. Emptying it removes them permanently.',
      icon: 'trash',
      safe: false,
      kind: 'recycle',
    },
    oldDownloadsDef('Recycle Bin'),
  ];
}

const MAC_BROWSER_CACHES = [
  'Google',
  'BraveSoftware',
  'Microsoft Edge',
  'Arc',
  'company.thebrowser.Browser',
  'com.apple.Safari',
  'Firefox',
  'Vivaldi',
  'com.operasoftware.Opera',
];
const MAC_DEV_CACHES = ['Yarn', 'pip', 'pnpm'];
// Sync and transfer state rather than caches: iCloud Drive / CloudKit bookkeeping and background downloads in flight.
const MAC_KEEP_CACHES = ['com.apple.bird', 'CloudKit', 'com.apple.cloudd', 'com.apple.nsurlsessiond', 'com.apple.akd', 'FamilyCircle'];

function macDefs(): Def[] {
  const support = (...p: string[]) => lib('Application Support', ...p);
  return [
    {
      id: 'mac-caches',
      name: 'User caches',
      description: 'Apps keep these to load faster and rebuild them when needed.',
      icon: 'layers',
      safe: true,
      kind: 'cache',
      roots: () => dirs([lib('Caches')], () => [...MAC_BROWSER_CACHES, ...MAC_DEV_CACHES, ...MAC_KEEP_CACHES]),
    },
    {
      id: 'mac-logs',
      name: 'Logs',
      description: 'Diagnostic logs apps write over time. Nothing needs them to run.',
      icon: 'doc',
      safe: true,
      kind: 'cache',
      roots: () => dirs([lib('Logs')]),
    },
    {
      id: 'browser-cache',
      name: 'Browser caches',
      description: 'Chrome, Safari, Firefox and others rebuild these as you browse. Logins and history stay.',
      icon: 'globe',
      safe: true,
      kind: 'cache',
      roots: async () => {
        const paths = [
          lib('Caches', 'Google', 'Chrome'),
          lib('Caches', 'BraveSoftware', 'Brave-Browser'),
          lib('Caches', 'Microsoft Edge'),
          lib('Caches', 'Arc'),
          lib('Caches', 'company.thebrowser.Browser'),
          lib('Caches', 'com.apple.Safari'),
          lib('Caches', 'Vivaldi'),
          lib('Caches', 'com.operasoftware.Opera'),
        ];
        for (const u of [
          support('Google', 'Chrome'),
          support('BraveSoftware', 'Brave-Browser'),
          support('Microsoft Edge'),
          support('Arc', 'User Data'),
          support('Vivaldi'),
        ]) {
          paths.push(...(await chromiumCaches(u)));
        }
        paths.push(...(await firefoxCaches(lib('Caches', 'Firefox', 'Profiles'))));
        return dirs(paths);
      },
    },
    {
      id: 'xcode',
      name: 'Xcode leftovers',
      description: 'DerivedData, old device support files and simulator caches. Xcode rebuilds them when needed.',
      icon: 'chip',
      safe: false,
      kind: 'cache',
      roots: () =>
        dirs([
          lib('Developer', 'Xcode', 'DerivedData'),
          lib('Developer', 'Xcode', 'iOS DeviceSupport'),
          lib('Developer', 'CoreSimulator', 'Caches'),
        ]),
    },
    {
      id: 'dev-cache',
      name: 'Developer caches',
      description: 'npm, Yarn, pnpm and pip caches. The next install downloads packages again.',
      icon: 'code',
      safe: false,
      kind: 'cache',
      roots: () =>
        dirs([
          path.join(home(), '.npm', '_cacache'),
          lib('Caches', 'Yarn'),
          lib('pnpm', 'store'),
          lib('Caches', 'pnpm'),
          lib('Caches', 'pip'),
          path.join(home(), '.gradle', 'caches'),
        ]),
    },
    {
      id: 'trash',
      name: 'Trash',
      description: 'Files you already deleted. Emptying it removes them permanently.',
      icon: 'trash',
      safe: false,
      kind: 'cache',
      roots: () => dirs([path.join(home(), '.Trash')]),
    },
    oldDownloadsDef('Trash'),
  ];
}

function linuxDefs(): Def[] {
  return [
    {
      id: 'linux-cache',
      name: 'User caches',
      description: 'Apps keep these to load faster and rebuild them when needed.',
      icon: 'layers',
      safe: true,
      kind: 'cache',
      roots: () => dirs([path.join(home(), '.cache')]),
    },
    {
      id: 'trash',
      name: 'Trash',
      description: 'Files you already deleted. Emptying it removes them permanently.',
      icon: 'trash',
      safe: false,
      kind: 'cache',
      // info/ holds the .trashinfo records; leaving them would show ghost items in the file manager.
      roots: () => dirs([path.join(home(), '.local', 'share', 'Trash', 'files'), path.join(home(), '.local', 'share', 'Trash', 'info')]),
    },
    oldDownloadsDef('Trash'),
  ];
}

function oldDownloadsDef(binName: string): Def {
  return {
    id: 'old-downloads',
    name: 'Old downloads',
    description: `Files in Downloads you have not touched for 90+ days. They go to the ${binName}, so you can restore them.`,
    icon: 'down',
    safe: false,
    kind: 'downloads',
  };
}

function platformDefs(): Def[] {
  const defs = isWin ? winDefs() : isMac ? macDefs() : linuxDefs();
  return defs.filter(d => d.kind !== 'recycle' && !['trash', 'win-update', 'win-system-temp'].includes(d.id));
}

const lower = (s: string) => s.toLowerCase();
const newest = (f: { mtimeMs: number; birthtimeMs: number }) => Math.max(f.mtimeMs, f.birthtimeMs || 0);

interface Measured {
  size: number;
  count: number;
  locations: string[];
}

/** Sizes what a clean would remove: every entry inside each root, minus excluded and too-fresh files. */
async function measureCache(def: Def, roots: Root[], onTick: (current: string) => void, exclusions: string[], signal?: AbortSignal, summary?: ScanSummary): Promise<Measured> {
  const cutoff = def.keepNewerThanMs ? Date.now() - def.keepNewerThanMs : undefined;
  const out: Measured = { size: 0, count: 0, locations: [] };
  for (const root of roots) {
    checkCancelled(signal);
    if (excludedPath(root.path, exclusions)) continue;
    summary?.roots.push(root.path);
    const excluded = new Set((root.exclude ?? []).map(lower));
    const entries = new Set<string>();
    let bytes = 0;
    const top = (p: string) => lower(path.relative(root.path, p).split(path.sep)[0]);
    const stats = await walk(root.path, {
      maxEntries: SCAN_CAP,
      signal,
      skipDir: (p, name, depth) => excludedPath(p, exclusions) || (depth === 1 && excluded.has(lower(name))),
      onDir: (p, depth) => {
        if (depth === 1 && cutoff === undefined) entries.add(top(p));
      },
      onFile: (f) => {
        if (excludedPath(f.path, exclusions)) { if (summary) summary.skipped++; return; }
        if (f.depth === 1 && excluded.has(lower(f.name))) return;
        // Same freshness rule as deleteCacheEntry, so the size shown matches what a clean removes.
        if (cutoff !== undefined && newest(f) >= cutoff) return;
        bytes += f.size;
        entries.add(top(f.path));
      },
      onTick: (_n, current) => onTick(current),
    });
    if (summary) { summary.visited += stats.files + stats.dirs; summary.unreadable += stats.unreadable; summary.skipped += stats.linked; summary.limited ||= stats.truncated; }
    if (incompleteWalk(stats)) throw new Error('Incomplete scan: unreadable, linked or limited cache entries');
    if (bytes > 0) {
      out.size += bytes;
      out.count += entries.size;
      out.locations.push(displayPath(root.path));
    }
  }
  return out;
}

/** Last opened (where the OS tracks it), changed or created: any of them makes a download "recent". */
const touched = (f: { mtimeMs: number; birthtimeMs: number; atimeMs: number }) =>
  Math.max(f.mtimeMs, f.birthtimeMs || 0, f.atimeMs || 0);

/** Top-level entries of Downloads whose content was all last touched 90+ days ago. */
export async function findOldDownloads(exclusions: string[] = [], signal?: AbortSignal): Promise<{ paths: string[]; size: number; folder: string; incomplete: boolean }> {
  const folder = knownFolder('downloads');
  const cutoff = Date.now() - OLD_DOWNLOAD_MS;
  const result = { paths: [] as string[], size: 0, folder, incomplete: false };
  let list: Dirent[];
  try {
    list = await fsp.readdir(folder, { withFileTypes: true });
  } catch {
    result.incomplete = true;
    return result;
  }
  const candidates = list.filter((d) => !DOWNLOAD_IGNORE.has(lower(d.name)) && (d.isFile() || d.isDirectory()));
  await mapLimit(candidates, 8, async (d) => {
    const p = path.join(folder, d.name);
    if (signal?.aborted || !isSafeUserPath(p) || excludedPath(p, exclusions) || exclusions.some(e => isInside(p, e))) return;
    try {
      const st = await fsp.lstat(p);
      if (st.isSymbolicLink()) return;
      if (st.isFile()) {
        if (touched(st) < cutoff) {
          result.paths.push(p);
          result.size += st.size;
        }
        return;
      }
      if (!st.isDirectory()) return;
      let fresh = touched(st) >= cutoff;
      let size = 0;
      const ctrl = new AbortController();
      const childDirs: string[] = [];
      const stats = await walk(p, {
        onDir: dir => childDirs.push(dir),
        signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
        maxEntries: 200_000,
        onFile: (f) => {
          size += f.size;
          if (touched(f) >= cutoff) {
            fresh = true;
            ctrl.abort();
          }
        },
      });
      // A folder we could not fully check is treated as in use.
      if (stats.truncated || stats.unreadable || stats.linked) { fresh = true; result.incomplete = true; }
      if (stats.aborted) fresh = true;
      for (const dir of childDirs) if (touched(await fsp.lstat(dir)) >= cutoff) fresh = true;
      if (!fresh) {
        result.paths.push(p);
        result.size += size;
      }
    } catch {
      result.incomplete = true;
      // unreadable: leave it alone
    }
  });
  result.paths = result.paths.filter((p) => isSafeUserPath(p));
  return result;
}

const RECYCLE_MEASURE = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$n=0; $t=[double]0',
  'foreach($i in (New-Object -ComObject Shell.Application).NameSpace(10).Items()){',
  '  $n++',
  "  $v=$i.ExtendedProperty('System.Size')",
  '  if($v -and [double]$v -gt 0){ $t+=[double]$v }',
  '  else { $m=(Get-ChildItem -LiteralPath $i.Path -Recurse -Force -File | Measure-Object -Property Length -Sum).Sum; if($m){ $t+=[double]$m } }',
  '}',
  '"$n $t"',
].join('\n');

function powershell(script: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

async function measureRecycleBin(): Promise<{ count: number; size: number }> {
  try {
    const out = (await powershell(RECYCLE_MEASURE, 90_000)).trim().split(/\s+/);
    const count = Number(out[out.length - 2]);
    const size = Number(out[out.length - 1]);
    return { count: Number.isFinite(count) ? count : 0, size: Number.isFinite(size) ? size : 0 };
  } catch {
    return { count: 0, size: 0 };
  }
}

async function measure(def: Def, onTick: (current: string) => void, exclusions: string[], signal?: AbortSignal, summary?: ScanSummary): Promise<Measured> {
  if (def.kind === 'recycle') {
    const r = await measureRecycleBin();
    return { size: r.size, count: r.count, locations: ['Recycle Bin'] };
  }
  if (def.kind === 'downloads') {
    const r = await findOldDownloads(exclusions, signal);
    if (r.incomplete) throw new Error('Downloads could not be fully inspected');
    return { size: r.size, count: r.paths.length, locations: r.paths.length ? [displayPath(r.folder)] : [] };
  }
  const roots = (await def.roots?.()) ?? [];
  return measureCache(def, roots, onTick, exclusions, signal, summary);
}

export async function scanJunk(progress: Progress, exclusions: string[] = [], signal?: AbortSignal): Promise<JunkCategory[]> {
  const defs = platformDefs();
  const found: JunkCategory[] = [];
  const summary: ScanSummary = { roots: [], visited: 0, skipped: 0, unreadable: 0, matched: 0, limited: false, cancelled: false, notes: [exclusions.length + ' saved exclusions. Cleanup uses known cache locations, not discovery folders. Counts cover inspected cache entries; download age checks are separate.'] };
  const warnings: string[] = [];
  for (let i = 0; i < defs.length; i++) {
    if (signal?.aborted) break;
    const def = defs[i];
    progress({ task: 'junk', phase: def.name, done: i, total: defs.length });
    let last = 0;
    const onTick = (current: string) => {
      const now = Date.now();
      if (now - last < 120) return;
      last = now;
      progress({ task: 'junk', phase: def.name, done: i, total: defs.length, current: displayPath(current) });
    };
    try {
      const m = await measure(def, onTick, exclusions, signal, summary);
      if (m.size <= 0) continue;
      found.push({
        id: def.id,
        name: def.name,
        description: def.description,
        icon: def.icon,
        size: m.size,
        count: m.count,
        locations: m.locations.slice(0, 24),
        safe: def.safe,
      });
    } catch {
      warnings.push(`${def.name} could not be fully inspected and was excluded`);
    }
  }
  summary.cancelled = Boolean(signal?.aborted); summary.matched = found.length;
  if (summary.cancelled) warnings.push('Scan cancelled; results are partial');
  summary.partial = warnings.length > 0;
  progress({ task: 'junk', phase: summary.cancelled ? 'Cancelled' : 'Done', done: found.length, total: defs.length, summary, warning: warnings.join('; ') });
  return found.sort((a, b) => b.size - a.size);
}

/** Preview exact leaf files; no directory-wide or Recycle Bin erasure. */
export async function previewJunk(ids: unknown, cursor?: string, exclusions: string[] = [], signal?: AbortSignal): Promise<RemovalPlan> {
  if (!Array.isArray(ids) || !ids.length || ids.length > 40 || ids.some(id => typeof id !== 'string')) throw new Error('Invalid categories');
  const selected = [...new Set(ids as string[])].sort();
  const defs = platformDefs();
  if (selected.some(id => !defs.some(d => d.id === id))) throw new Error('Unsupported cleanup category');
  if (cursor !== undefined) return nextCleanupBatch(cursor, selected, exclusions, signal);
  const candidates: CleanupCandidate[] = [];
  const seen = new Set<string>();
  let limited = false;
  for (const def of defs.filter(d => selected.includes(d.id))) {
    checkCancelled(signal);
    if (def.kind === 'downloads') {
      const result = await findOldDownloads(exclusions, signal);
      checkCancelled(signal);
      if (result.incomplete) throw new Error('Downloads preview is incomplete');
      for (const p of result.paths) {
        if (candidates.length >= 100_000) { limited = true; break; }
        candidates.push({ path: p, action: 'trash' });
      }
      continue;
    }
    for (const root of await def.roots?.() ?? []) {
      checkCancelled(signal);
      if (excludedPath(root.path, exclusions)) continue;
      await assertNoLinks(root.path);
      const stop = new AbortController();
      const cutoff = def.keepNewerThanMs ? Date.now() - def.keepNewerThanMs : undefined;
      const names = new Set((root.exclude ?? []).map(lower));
      const stats = await walk(root.path, {
        maxEntries: SCAN_CAP,
        signal: signal ? AbortSignal.any([signal, stop.signal]) : stop.signal,
        skipDir: (p, name, depth) => excludedPath(p, exclusions) || (depth === 1 && names.has(lower(name))),
        onFile: f => {
          if (excludedPath(f.path, exclusions) || (f.depth === 1 && names.has(lower(f.name))) || (cutoff !== undefined && newest(f) >= cutoff) || seen.has(f.path)) return;
          if (candidates.length >= 100_000) { limited = true; stop.abort(); return; }
          seen.add(f.path); candidates.push({ path: f.path, action: 'delete', cutoff });
        },
      });
      checkCancelled(signal);
      limited ||= stats.truncated || stats.unreadable > 0 || stats.linked > 0;
      // Each batch snapshots only verified leaves. No uninspected subtree is removed.
      if (candidates.length >= 100_000) break;
    }
    if (candidates.length >= 100_000) { limited = true; break; }
  }
  checkCancelled(signal);
  candidates.sort((a,b) => a.path.localeCompare(b.path));
  return nextCleanupBatch(startCleanupBatches(candidates, selected, limited), selected, exclusions, signal);
}

/** Raw category execution is retired; execution requires a preview token. */
export async function cleanJunk(_ids: unknown, _progress: Progress): Promise<CleanResult> {
  assertDestructiveFeaturesEnabled();
  throw new Error('Preview cleanup and execute the resulting removal plan');
}
