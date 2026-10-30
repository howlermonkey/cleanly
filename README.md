# EvenCleaner Development

Development fork of [0xCodez/cleanly](https://github.com/0xCodez/cleanly), reviewed at commit `1c4109bad63d34f4ef5d22220aaf555770a92bcc`.

**Deletion, Trash, uninstall and startup changes are disabled. This is not an approved cleaner release.** You can inspect scan results and request exact removal previews. The application cannot execute those previews. Installer packaging is blocked, and CI produces no release binaries.

## Development

Use Node 22 and the committed npm lockfile:

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run demo
```

`demo` uses synthetic data in a browser; it does not scan your computer. The desktop development command is `npm run dev`; Electron's binary must be installed separately after reviewing its install script. The safety lock also applies to the desktop app and its main-process API. No environment variable or Settings toggle can unlock it.

## Safety changes

- File removal uses immutable, expiring, single-use manifests held in the main process. Previews list every selected path and whether the planned action is permanent deletion or Trash.
- Filesystem identities and duplicate keeper content are revalidated. Incomplete folder scans, changed files and linked ancestors reject approval. Permanent directory-wide deletion and bin-emptying have been removed from the execution flow.
- Large Files and Duplicates default to OS-known personal folders, including supported folder redirection. Application databases, credential stores and package contents are excluded.
- A shared coordinator rejects overlapping mutations. Settings and key updates serialize the entire transaction.
- Partial scans are disclosed; outcomes distinguish removals, failures and skipped items. Moving bytes to Trash is not reported as reclaimed disk space.
- AI recommendations cannot mark a file safe for removal. AI requests send the question, selected metadata (names, paths, sizes, modification dates) and disk summary, never file contents. Sensitive names may still be visible to the selected provider.
- The development app has a separate application identity. Upstream donations and feedback destinations are disabled. Original authorship is retained.

## Acceptance and limitations

Read [SAFETY-ACCEPTANCE.md](SAFETY-ACCEPTANCE.md) for evidence and the remaining native-platform release gates. The [upstream review](docs/UPSTREAM-REVIEW.md) is a historical report from before this fork; its findings describe the pinned upstream revision, not the current development branch.

The repository remains `UNLICENSED`. No new reuse or redistribution permission is implied. Suitable upstream permission and trusted Windows/macOS signing remain prerequisites for distribution.

## CodeGraph

A local CodeGraph was initialized for this checkout. Its database is machine-local and ignored by Git. After source changes, run `codegraph sync`. New checkouts can run `codegraph init -i`.
