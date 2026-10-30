**Cleanly pre-adoption review — 30 October 2026**

**Decision: hold. I would not approve this revision for cleaning a normal workstation.** The repository has useful structure and several deliberate security protections, but its safety claims exceed what the filesystem checks enforce. Your instruction made forking and cloning conditional on a satisfactory review, so neither was performed. A pinned source archive was downloaded solely for inspection.

Reviewed repository: [0xCodez/cleanly](https://github.com/0xCodez/cleanly). Reviewed commit: [1c4109bad63d34f4ef5d22220aaf555770a92bcc](https://github.com/0xCodez/cleanly/commit/1c4109bad63d34f4ef5d22220aaf555770a92bcc), package version 0.1.1. GitHub history showed 20 commits across 29–30 October 2026. This is an early project, not an established maintenance record.

**What was verified**

| Check | Result |
|---|---|
| Source review | All Electron services and IPC boundary; renderer cleanup, duplicate, AI, settings, startup, app, support and feedback flows; build scripts and release configuration |
| Dependency installation | Locked dependencies installed with lifecycle scripts disabled; no Electron binary installation |
| TypeScript | Both renderer and main-process checks passed |
| Production source build | Vite renderer and esbuild main/preload bundles passed |
| Dependency advisory query | npm audit returned zero known vulnerabilities across the full dependency graph, including development dependencies |
| Focused reproductions | Six mocked cases reproduced the unsafe decisions/race described below |
| Actual destructive operations | None: no cleaner launched, no real files trashed/deleted, no startup settings changed |
| Fork / clone | Neither performed |

All 421 locked package entries with resolved download URLs point to registry.npmjs.org and have integrity hashes. A targeted pattern scan of first-party source found no matching GitHub/AWS/OpenAI-style credentials or private-key headers; this is not a comprehensive secret audit. The downloaded source archive SHA-256 is C51D5EEB3F7E150A5F70EE3EAE02146B2BD9131FD6BE98BECF85C2AE81DD46D4.

The review harness loads the actual TypeScript modules into a VM with synthetic Windows paths and mocked filesystem/Electron/process interfaces. It validates application decisions, not real Windows junction behavior or OS permission enforcement. These successful reproductions demonstrate defects; they are not six passing safety tests.

**1. [P1] Custom project temporary directories qualify for permanent, default-selected cleanup**

Location: [electron/services/junk.ts:101](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/junk.ts#L101) and [electron/services/junk.ts:124](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/junk.ts#L124).

The comment says a project's tmp directory must not qualify. The implementation excludes custom locations under known user folders or the home directory, but accepts a directory outside home if its final component is tmp or temp. With TEMP pointing to D:\\projects\\customer-data\\tmp, userTempDir() returns that exact project directory. The category is marked safe and preselected; files older than the freshness cutoff can be permanently unlinked.

This requires a custom environment configuration, not an attacker or renderer compromise. The directory name alone does not prove disposable contents. The harness reproduced acceptance of this path.

Fix: restrict default cleanup to explicitly trusted OS temporary directories. Treat custom locations as a separately disclosed, opt-in target with preview and conservative handling.

**2. [P1] A cache root redirected through an ancestor defeats the permanent-delete containment check**

Location: [electron/services/junk.ts:52](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/junk.ts#L52), [electron/services/trash.ts:263](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/trash.ts#L263).

Directory discovery checks the final directory entry. deleteCacheEntry checks whether the canonical target is inside the canonical root, but never establishes that the canonical root itself is an approved cache location. If an ancestor such as AppData\\Roaming\\Slack is a junction to another directory, Slack\\Cache can appear to be a normal directory while resolving into user data.

The harness supplied a normal file whose requested cache root resolved to Documents\\Cache. deleteCacheEntry accepted it and invoked the mocked unlink for report.docx. This reproduces the missing trust check without creating a junction or deleting any file.

There is also a separate race window: paths are collected, then unlinked later without rechecking directory identity. The top-level canonical check alone does not protect against a directory being replaced between traversal and deletion. That race was identified statically, not exercised.

Fix: validate canonical roots and every relevant ancestor against a trusted cleanup policy before traversal; reject unexpected reparse points; minimize and test check/use races. Legitimately relocated caches need an explicit policy rather than an implicit exception.

**3. [P1] Large Files offers live application data for removal**

Location: [electron/services/largeFiles.ts:90](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/largeFiles.ts#L90), [electron/services/trash.ts:103](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/trash.ts#L103), [src/screens/LargeFiles.tsx:149](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/src/screens/LargeFiles.tsx#L149).

Large Files walks the entire home directory. It excludes certain cache folders but does not exclude mail stores, browser databases, application installations under AppData, or macOS library/package internals. The trash guard blocks AppData and its first-level folders as whole objects, but allows most deeper paths.

The harness demonstrated that a synthetic 1 GB Thunderbird Mail\\Inbox file passes the scanner's directory policy, appears as a removable result, and passes isSafeUserPath(). A closed application's database can therefore be moved to Trash through the ordinary UI. Recovery may be possible, but an application can recreate state or malfunction before restoration.

Related guard gaps: the credential-store check blocks Microsoft\\Protect itself but allows its ancestor AppData\\Roaming\\Microsoft; unlisted secret stores such as .aws\\credentials also pass. Those guard results were reproduced. The latter small files would not normally meet the Large Files threshold; do not interpret that result as proof the ordinary UI automatically selects them.

Fix: use a shared conservative policy for scan eligibility and deletion, with explicit protection of application state, package internals, credential stores and ancestors containing protected roots. Personal files should be the default scope.

**4. [P2] Old Downloads can include folders whose contents could not be inspected**

Location: [electron/services/walk.ts:100](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/walk.ts#L100), [electron/services/walk.ts:117](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/walk.ts#L117), [electron/services/junk.ts:475](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/junk.ts#L475).

The shared walker silently ignores readdir/lstat failures. findOldDownloads treats a truncated scan as unsafe, but receives no incomplete/error flag for unreadable descendants. A folder whose top-level timestamps and visible files are old can be classified as an old download even when hidden or unreadable contents were never checked.

The harness reproduced an old folder with one visible old file and an unreadable child directory being selected. Its visible size was nonzero, so this is not limited to empty categories. Whether the OS subsequently permits recycling that folder depends on permissions.

Fix: propagate incomplete/error state from traversal; exclude any folder that cannot be fully inspected. Track relevant directory timestamps too, not only file timestamps.

**5. [P2] Duplicate removal trusts stale results and does not verify that a keeper still exists**

Location: [src/screens/Duplicates.tsx:29](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/src/screens/Duplicates.tsx#L29), [src/screens/Duplicates.tsx:91](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/src/screens/Duplicates.tsx#L91), [src/screens/Duplicates.tsx:111](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/src/screens/Duplicates.tsx#L111), [electron/services/trash.ts:170](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/trash.ts#L170).

Duplicate groups persist while the app is open. The UI preselects all non-keeper copies, then sends only the paths to trash. The backend receives no group hash, keeper identity or scan token. If the keeper has been removed, or a selected copy has changed since scanning, the action still proceeds based on the old group.

Full SHA-256 hashing is a positive feature at scan time; it does not establish duplication at deletion time. This is a statically traced defect, not a claim that a hash collision was found.

Fix: add a dedicated duplicate-removal API. Revalidate keeper existence, file identity and changed content before moving any copy, and refuse stale groups.

**6. [P2] Destructive operations have no shared coordination**

Location: [electron/main.ts:83](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/main.ts#L83), [src/state.tsx:164](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/src/state.tsx#L164), [src/screens/LargeFiles.tsx:62](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/src/screens/LargeFiles.tsx#L62), [electron/services/junk.ts:631](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/junk.ts#L631).

Junk cleaning, file trashing, and uninstallation are separate async handlers without a main-process mutation queue. Large Files and Duplicates maintain local busy state that disappears on navigation; they do not consult a shared destructive-operation lock.

Within a single cleanJunk call, the implementation correctly empties the bin before moving old downloads. That ordering does not protect separate overlapping calls. Starting a long trash operation and switching to Cleanup to empty the bin can permanently remove some newly trashed items while the first operation is still promising recoverability.

Fix: coordinate destructive operations centrally, keep job state across navigation, and prevent bin-emptying while any trash operation is in flight. Test this interleaving with mocked delayed OS calls. The interleaving was identified statically in this review.

**7. [P2] Failed cleanup is shown as completed, and recycled bytes are called freed bytes**

Location: [src/state.tsx:169](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/src/state.tsx#L169), [electron/services/trash.ts:196](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/trash.ts#L196), [electron/services/junk.ts:657](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/junk.ts#L657).

After any resolved cleanJunk response, the store sets every requested category's size and count to zero, even if all files were locked or denied. Smart Scan can then say All clear and Cleanup can label those categories Clean.

Separately, trashPaths adds the logical size of recycled items to result.freed. cleanJunk includes that value for old downloads and displays it as disk space freed, although moving files to the same volume's bin normally retains their storage.

Fix: remeasure affected categories or return per-category outcomes; distinguish bytes moved to Trash from actual reclaimed disk space. Preserve failed/remaining items in the UI.

**8. [P2] Concurrent settings and key updates can overwrite each other**

Location: [electron/services/settings.ts:38](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/settings.ts#L38), [electron/services/settings.ts:133](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/settings.ts#L133), [electron/services/settings.ts:149](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/settings.ts#L149).

writeJson serializes file writes, but each caller calculates its replacement object before entering that queue. Two concurrent patches therefore start from the same old settings. The second replacement loses the first patch.

The harness concurrently set background=grid and largeFileMinMb=1000. The final result kept 1000 but reverted the background to mist. The API-key read/copy/write path has the same structure; a key-save/removal race needs its own regression case.

Fix: serialize the whole read-modify-write transaction and cache update, rather than only the final filesystem operations.

**9. [P2] Incomplete scans look complete**

Location: [electron/services/junk.ts:419](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/junk.ts#L419), [electron/services/largeFiles.ts:90](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/largeFiles.ts#L90), [electron/services/spaces.ts:142](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/spaces.ts#L142), [electron/services/duplicates.ts:19](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/duplicates.ts#L19).

Junk measurement caps traversal, while deletion walks selected cache entries without that cap. Large Files caps traversal and returns the largest 300 results from what it examined. Space Map budgets its walk and can label the unmeasured remainder as system/hidden storage. Duplicate scanning caps candidate work and returns only 200 groups. The public result types do not communicate these limitations to the user.

Consequences include understated cleanup previews, missing large files, and misleading explanations of disk use. The shared walker also hides permission failures. These are source-level observations; a multi-million-file performance benchmark was not run.

Fix: return completeness, skipped/unreadable counts and limit reasons; disclose partial results. Bound deletion to a reviewed plan or clearly re-preview changes before execution.

**10. [P2] Browser and app cleanup labels persistent site caches as universally safe**

Location: [electron/services/junk.ts:70](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/junk.ts#L70), [electron/services/junk.ts:121](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/junk.ts#L121).

The default safe categories include Service Worker\\CacheStorage, not just disposable HTTP/GPU caches. Web applications control this persistent storage and can depend on it for offline operation. The assertion that everything will rebuild when needed is too broad, particularly without connectivity. [MDN documents Cache as persistent request/response storage](https://developer.mozilla.org/en-US/docs/Web/API/Cache).

No specific third-party app data-loss scenario was executed. This is a cleanup-policy concern supported by the chosen paths, not proof that every CacheStorage deletion loses unique user data.

Fix: separate offline/site storage from ordinary caches, require review, and explain consequences. Running-application checks should complement locked-file handling.

**11. [P2] AI safety verdicts rely too heavily on the model**

Location: [electron/services/ai.ts:131](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron/services/ai.ts#L131), [src/screens/Assistant.tsx:302](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/src/screens/Assistant.tsx#L302).

The system prompt asks the model not to mark personal/app data as safe. The response validator only downgrades a safe verdict when the path was absent from supplied context. A known personal file or application database can still receive Safe to remove, and the UI can present a trash action for it. Combined with finding 3, the deterministic policy does not enforce the prompt's promise.

Positive boundary: the model cannot execute commands or automatically delete files; the UI requires a user action and confirmation.

Fix: enforce eligibility and maximum verdict in application code. Treat model text as advice and require review for personal files regardless of model classification.

**Licensing prerequisite**

There is no LICENSE file, GitHub reports no detected license, and [package.json:7](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/package.json#L7) explicitly says UNLICENSED. This is not a basis for assuming permission to build and redistribute your own product from it. Obtain a suitable license or explicit permission before adoption.

This does not mean GitHub forking itself is forbidden: GitHub distinguishes the right to view/fork public repositories from broader reuse rights. [GitHub's licensing guidance explains the distinction](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository). The decision to withhold this conditional fork is based on the review outcome, including the concrete safety defects.

**Release and maintenance concerns**

- No automated tests or test script are present. CI runs on manual dispatch or version tags, not pull requests or ordinary pushes. It builds/types checks but provides no regression protection for destructive behavior. [.github/workflows/build.yml:3](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/.github/workflows/build.yml#L3).
- macOS builds use ad-hoc signing with hardened runtime and notarization disabled. The README directs users to clear quarantine; Windows releases are also described as unsigned. Signing and trusted distribution need work before release under your name. [electron-builder.yml:42](https://github.com/0xCodez/cleanly/blob/1c4109bad63d34f4ef5d22220aaf555770a92bcc/electron-builder.yml#L42).
- Actions use mutable version tags. The workflow provides neither artifact attestations nor an explicit checksum/signature publication step. Released executable contents were not compared against source.
- All dependencies are classified as development dependencies, including React and the bundled Anthropic SDK. An audit that excludes development dependencies would miss code shipped in the product. The audit here included them.
- Some locked dependencies produced deprecation warnings, although the advisory query returned zero vulnerabilities. That result is a point-in-time known-advisory check, not proof of supply-chain safety.
- There is no updater integration or demonstrated maintenance policy. Installer testing, OS compatibility, and recovery behavior still need validation.

**Other observations and boundaries**

| Area | Assessment |
|---|---|
| Electron isolation | Good baseline: sandbox, context isolation, Node integration disabled, restricted preload methods, sender-URL validation, navigation/pop-up controls, production CSP |
| Electron hardening | No explicit permission-request policy or fuse configuration. These are defense-in-depth tasks, not a demonstrated remote exploit. Electron recommends deliberate permission and IPC validation policies. [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security) |
| Keys | OS-backed safeStorage encryption; no plaintext fallback when saving; secret values not returned through getSettings |
| Network behavior | AI calls go to the chosen provider. Support uses beyond-media.ai; current feedback opens a mail draft. No obvious credential-exfiltration or analytics routine found in the reviewed application source |
| AI privacy | Sends question, paths, sizes, modification dates and disk summary. Home-prefix replacement reduces account-name exposure but does not remove sensitive filenames or names embedded in other drive paths. UI/README omit modification dates from their disclosure. No live AI requests made |
| Fork branding | Donation recipient, feedback email, application ID and product name are upstream-specific. A future independent build must review these and avoid sharing upstream configuration identity unintentionally |
| Checkout links | Tips service can return any HTTPS checkout host. Restrict destinations to expected payment hosts; the remote payment backend itself was outside scope |
| Startup | Windows elevation arguments are quoted and registry writes are verified. Impact ratings are name-based heuristics, not measured boot cost. macOS bootstrap/bootout errors are ignored after persistence succeeds, so immediate effects may not match the UI |
| Uninstall | Windows executes a registry-sourced command through a shell; renderer input is limited to IDs. Registry commands remain a local trust boundary, and success means the shell started, not that uninstall completed |
| Protection | Read-only heuristics, not an antivirus. Unknown antivirus state is represented as disabled in some paths, and XProtect presence is used as a proxy for realtime protection. Avoid treating the score as a security assurance |
| Platform coverage | Windows behavior examined through source and mocks. macOS reviewed statically only. Linux packaging exists, but several services return unsupported/empty results |
| UI | Useful labels and keyboard controls exist. Full accessibility, visual, screen-reader and GPU-performance testing was not performed; the WebGL reduced-motion branch still renders continuously at a lower animation speed |

**Recommended acceptance criteria**

1. Fix permanent-deletion root validation and protect app/credential data in both scanners and mutation handlers.
2. Add dry-run manifests, stale-plan rejection, coordinated destructive operations and trustworthy per-item/per-category outcomes.
3. Add regression tests covering junctions/reparse points, redirected folders, inaccessible descendants, changed duplicate keepers, locked files, concurrent operations and settings writes.
4. Run destructive integration tests only on disposable Windows/macOS fixtures; verify restore behavior and absence of out-of-scope mutations.
5. Resolve reuse licensing and branding, then establish signed release builds and PR CI before distribution.

A development-only fork could be useful if you deliberately want to repair these issues. It should not be treated as approved cleaner software at this revision.

**Evidence saved in this workspace**

- Source archive and extracted pinned source: .review/
- Mocked reproduction harness: .review/review-harness.cjs
- Reproduction results: .review/reproductions.json
- Build/typecheck output: .review/build.log
- Dependency audit: .review/npm-audit.json
- Dependency installation log: .review/npm-install.log

No upstream source files were edited. Only review evidence and build/dependency outputs were added. No public issue, message, fork or other GitHub mutation was created. Commit messages were inspected, but this review did not audit every historical file revision, attest released binaries, or perform a formal exhaustive security proof.
