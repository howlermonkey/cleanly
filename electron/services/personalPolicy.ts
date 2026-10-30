import os from 'node:os';
import path from 'node:path';
import { knownFolders } from './walk';
import { isInside, samePath } from './pathSafety';

const PROTECTED = /^(appdata|library|applications|program files( \(x86\))?|programdata|windows(\.old)?|node_modules|vendor|\.git|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.config|\.local|\.codex|\.agents|\.docker|\.npm|\.cache|\.trash|\$recycle\.bin|system volume information|recovery|boot|efi)$/i;
const PACKAGE = /\.(app|photoslibrary|photolibrary|musiclibrary|tvlibrary|imovielibrary|fcpbundle|logicx|band|aplibrary|lrdata|lrlibrary|bundle|framework|plugin|kext|xcodeproj|xcworkspace|pkg|mpkg|sparsebundle|rtfd|pages|numbers|key|vmwarevm|pvm|utm)$/i;
const SENSITIVE_FILE = /(?:^ntuser\.|^credentials$|^id_(?:rsa|ed25519|ecdsa)|\.(?:db|sqlite[0-9]?|pst|ost|keychain(?:-db)?|pem|p12|pfx|wallet)$)/i;

export function personalRoots(): string[] {
  return [...new Set(Object.values(knownFolders()).map(p => path.resolve(p)))];
}

/** The default scope is ordinary personal folders, including OS-known redirection. */
export function isPersonalPath(value: unknown, roots = personalRoots(), home = os.homedir()): value is string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value) || /^[\\/]{2}/.test(value)) return false;
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.indexOf(':', 2) !== -1)) return false;
  const p = path.resolve(value);
  if (samePath(p, home) || samePath(p, path.parse(p).root)) return false;
  // Never move a known folder or any ancestor that contains one.
  if (roots.some(r => samePath(r, p) || isInside(p, r))) return false;
  if (!roots.some(r => isInside(r, p))) return false;
  const parts = p.slice(path.parse(p).root.length).split(path.sep);
  if (parts.some(s => PROTECTED.test(s) || PACKAGE.test(s) || (process.platform === 'win32' && /[. ]$/.test(s)))) return false;
  return !SENSITIVE_FILE.test(path.basename(p));
}
