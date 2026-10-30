# Safety acceptance record

Status: development-only, destructive features and packaging remain disabled.

The subsequent [discovery milestone](DISCOVERY.md) adds configurable read-only scope and cancellable review workflows. It does not complete or waive any native mutation/release gate below. Cleanup now uses a bounded candidate inventory and 500-item pages rather than rejecting an entire category at 10,000 entries.

## Completed local validation

- Windows, Node 22: all 26 safety regression tests passed with no skipped tests, including real junction/hardlink fixtures.
- TypeScript validation and the renderer/main/preload production-source build passed. No installer was created.
- Local headless Chrome using synthetic demo data: Smart Scan, Cleanup, Duplicates and Large Files each displayed a preview with Confirm removal disabled; startup switches were disabled. No JavaScript runtime exceptions were observed.
- The package-script release check exited with the expected blocking error. The regression suite also verifies the builder hook rejects packaging.
- CodeGraph was initialized and synchronized after the implementation changes.

These results are development checks. They do not satisfy the native OS Trash, restoration and race-resistance gate below.

## Acceptance matrix

| Criterion | Development evidence | Remaining gate |
| --- | --- | --- |
| Bound cleanup roots and protect personal/app/credential data | Conventional per-user Windows cache roots; ignores custom TEMP/APPDATA overrides. Ancestor link and realpath checks; personal-folder policy shared by scans and removal previews; permanent directory removal excluded. | Native handle-relative deletion with verified reparse handling and resistance to concurrent ancestor replacement. Path checks followed by OS operations are not atomic. |
| Exact manifests and trustworthy outcomes | UUID tokens held in main process, immutable snapshots, five-minute expiry, single use, 10,000-item limit. File identity, directory inventory and duplicate keeper SHA-256 rechecks. Shared mutation coordination. Per-item outcomes, re-scan after execution, Trash bytes separate from unmeasured freed bytes. | OS-backed execution remains locked. No claim of actual reclaimed allocation from file lengths. |
| Regression tests | `npm test` covers Windows/macOS path rules, native fixture junctions or symlinks, redirected folders, inaccessible descendants, stale selections/keepers, hardlinks, locked-operation failures, concurrency, settings/key writes, AI verdicts, exact cache scope and packaging gate. | Mocked permission failures and busy files supplement, but do not replace, real ACL/open-handle tests. |
| Disposable Windows/macOS destructive integration | Test adapters operate only inside freshly generated `.test-fixtures/evencleaner-safety-*` directories. Recovery adapter preserves bytes and outside sentinels. No real Trash or uninstall calls. | Disposable VM tests of actual OS Trash/restore, ACLs/open handles, cloud placeholders, mount changes, all reparse types, active apps, concurrent rename races and absence of out-of-scope changes. macOS case-sensitive and ordinary volumes; Windows local and redirected known folders. |
| Licensing, branding, signed releases and PR CI | Separate development app identity; upstream payment/feedback disabled; SHA-pinned CI on pushes/PRs for Windows/macOS; package scripts and builder hook reject packaging. | Upstream reuse permission, full product branding/assets review, Windows Authenticode, Apple Developer ID/hardened runtime/notarization, reproducible release evidence/checksums/attestations. No credentials or legal permission have been assumed. |

## Native validation protocol before enabling any mutation

1. Use fresh disposable Windows and macOS VMs with no personal data, credentials or shared host folders. Record OS, volume format, commit, Electron version and fixture inventory/hash manifest.
2. Create ordinary personal folders plus external sentinels, redirected known folders, linked ancestors, protected data stores, packages, locked files, inaccessible subtrees, cloud placeholders and hardlink groups.
3. Exercise each OS adapter with exact manifests. Race ancestor replacement, target replacement and keeper deletion during preflight and execution. Any out-of-manifest mutation fails acceptance. Implement native handle-based protection before claiming race resistance; repeated path checks alone are insufficient.
4. Verify that all intended Trash items can be restored byte-for-byte with expected paths/metadata, that failures are visible, and that concurrent operations cannot erase recovery data. Test real allocated/free space separately from logical file size.
5. Review cache category semantics and active-application handling on each supported OS. Broad cache categories are heuristic and may contain persistent offline state; they are not a deletion safety guarantee.
6. Save machine-readable results and platform logs. Review the evidence before changing `shared/safety.ts` or the packaging gate. A green unit-test job never automatically unlocks production mutation.

## Regression harness boundaries

The Node test harness transpiles the actual TypeScript services into isolated module instances. Electron, subprocess and network provider entry points are denied by default. Tests supply fixture adapters explicitly. Junctions/symlinks, hardlinks, identity snapshots and ordinary file operations use the real filesystem inside the generated fixture directory. Only that directory is recursively removed during teardown, after verifying its parent and generated name.

`CleanResult.freed` is a legacy numeric placeholder when `freedMeasured` is false; callers must not present it as measured reclaimed storage. Preview execution returns per-item outcomes and remeasures disk state in the UI. Raw-path/category mutation APIs remain blocked and retired.

Read-only scanners can still encounter files that change while being inspected. The current JS path checks conservatively reject observable links; they do not establish atomic protection against every Windows reparse point or native filesystem race. These limitations are why the destructive lock remains on.
