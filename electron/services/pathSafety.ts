import { promises as fs } from 'node:fs';
import path from 'node:path';

// macOS can use a case-sensitive volume. A false negative is safer than aliasing two files.
export const normalizePath = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
export const samePath = (a: string, b: string) => normalizePath(a) === normalizePath(b);
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(normalizePath(parent), normalizePath(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Fail closed on links anywhere in the path, including the selected root's ancestors. */
export async function assertNoLinks(input: string): Promise<void> {
  if (!path.isAbsolute(input) || input.includes('\0') || /^[\\/]{2}/.test(input)) throw new Error('Local absolute paths only');
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(input) || input.indexOf(':', 2) !== -1)) throw new Error('Invalid Windows path');
  const abs = path.resolve(input);
  const root = path.parse(abs).root;
  let current = root;
  for (const part of ['', ...abs.slice(root.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const st = await fs.lstat(current);
    if (st.isSymbolicLink()) throw new Error('Linked paths are excluded');
  }
  if (!samePath(await fs.realpath(abs), abs)) throw new Error('Redirected paths are excluded');
}

export interface FileIdentity {
  path: string;
  device: string;
  inode: string;
  size: number;
  modified: string;
  changed: string;
  directory: boolean;
}

export async function fileIdentity(p: string): Promise<FileIdentity> {
  await assertNoLinks(p);
  const s = await fs.lstat(p, { bigint: true });
  if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) throw new Error('Unsupported filesystem object');
  return { path: path.resolve(p), device: String(s.dev), inode: String(s.ino), size: Number(s.size),
    modified: String(s.mtimeNs), changed: String(s.ctimeNs), directory: s.isDirectory() };
}

export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return samePath(a.path, b.path) && a.device === b.device && a.inode === b.inode && a.size === b.size &&
    a.modified === b.modified && a.changed === b.changed && a.directory === b.directory;
}
