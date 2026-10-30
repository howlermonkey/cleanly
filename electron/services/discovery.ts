import path from 'node:path';
import os from 'node:os';
import type { DiscoveryOptions, Settings } from '../../shared/types';
import { personalRoots, isPersonalPath } from './personalPolicy';
import { isInside, samePath, normalizePath } from './pathSafety';

export function localPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') &&
    path.isAbsolute(value) && !/^[\\/]{2}/.test(value) &&
    (process.platform !== 'win32' || (/^[a-z]:[\\/]/i.test(value) && value.indexOf(':', 2) === -1 && !value.split(/[\\/]/).some(s => /[. ]$/.test(s))));
}
export function validScanRoot(value: unknown): value is string {
  return localPath(value) && !samePath(value, path.parse(value).root) && !samePath(value, os.homedir()) &&
    isPersonalPath(path.join(value, '__scope_check__'), [value]);
}
export function excluded(p: string, exclusions: readonly string[]): boolean {
  return exclusions.some(e => samePath(e, p) || isInside(e, p));
}
export function discoveryOptions(settings?: Settings): DiscoveryOptions {
  const roots = settings?.scanRoots.length ? settings.scanRoots : personalRoots();
  const unique = [...new Map(roots.map(r => [normalizePath(r), path.resolve(r)])).values()];
  return { roots: unique.filter((r, i) => !unique.some((p, j) => i !== j && isInside(p, r))),
    exclusions: settings?.excludedPaths ?? [], minBytes: settings?.duplicateMinBytes ?? 1024 * 1024,
    includeHidden: settings?.includeHidden ?? false };
}
/** Discovery scope is independent of the more restrictive mutation policy. */
export function discoverable(p: string, options: DiscoveryOptions): boolean {
  return !excluded(p, options.exclusions) && isPersonalPath(p, options.roots);
}
