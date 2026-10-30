import { assertDestructiveFeaturesEnabled } from '../../shared/safety';
import type { CleanResult } from '../../shared/types';
import { isPersonalPath, personalRoots } from './personalPolicy';
import os from 'node:os';

export function isSafeUserPath(p: unknown, home = os.homedir(), _drives: readonly string[] = []): p is string {
  return isPersonalPath(p, personalRoots(), home);
}

/** Raw-path removal is retired, including after the release lock is lifted. */
export async function trashPaths(_paths: unknown): Promise<CleanResult> {
  assertDestructiveFeaturesEnabled();
  throw new Error('Preview the files and execute the resulting removal plan');
}
