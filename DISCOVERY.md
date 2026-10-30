# Discovery and review milestone

All destructive operations and installer packaging remain locked. Additional scan folders never expand removal permissions.

## Using the workflows

1. Open Settings → Scan folders and exclusions. With no custom folders, Duplicates and Large Files use the OS-known personal folders. Choosing custom local folders replaces that default list. Use “Use default folders” to restore it. Home/drive roots, network shares, linked roots and protected app/credential locations are not accepted by the picker.
2. Set the duplicate minimum to “All non-empty files”, 1 KB, 1 MB, 10 MB or 100 MB. Optionally include names beginning with a dot; protected paths remain excluded. Windows Hidden attributes are not a separate filter.
3. Add exact file/folder paths to Saved exclusions. Descendants of excluded folders are skipped. These settings also apply to cleanup scans and subsequent cleanup batches; they do not change Space Map's disk-accounting scope. Settings persist across restarts. Changes apply to the next scan.
4. Run Duplicates or Large Files. Each scan reports roots, counts, exclusions and cancellation/limit status. Duplicate results contain all groups discovered within the traversal budget; the UI reveals them in pages of 30. No duplicate group is preselected. Choose groups, a keeper, and any additional copies to retain. Matches outside the personal-file removal policy are marked “Discovery only”; Show in folder remains available.
5. Open Cleanup and select categories. Each preview holds at most 500 verified items. Uncheck unwanted files and choose “Update preview”, or save the unchecked paths as persistent exclusions. The main process permits only a subset of the original manifest and revalidates its identities; an updated preview invalidates the old token. “Review next batch (skip this one)” advances through the fixed inventory without deleting anything. Excluding every item invalidates that preview and advances to the next available batch when possible.
6. Use the Cancel controls while scanning or preparing previews. Global controls remain available after switching screens. Duplicate and large-file cancellation can return partial results with an explicit summary. Cancelled preview preparation returns no executable plan. Space Map cancellation preserves any previously displayed map and reports the cancelled request.

## Limits and remaining work

- Up to 100 custom roots and 1,000 saved exclusions. Exclusions are literal paths, not wildcards. Extra scan folders remain discovery-only wherever the original removal policy does not permit them.
- Duplicate traversal stops at 400,000 entries; empty files are excluded. This is exact-content matching, not similarity matching. Cloud-only files and hardlinks are excluded. Group results are no longer truncated to 200, but a removal preview remains limited to 200 selected groups and 10,000 selected copies.
- Large Files returns the largest 300 observed matches and reports traversal/result limits. Scans are snapshots, not filesystem monitors.
- Cleanup inventory is capped at 100,000 candidates and 1.5 million traversal entries per cache root. Partial inventory is disclosed. Narrow categories/exclusions and rescan if limits are reached. Each page snapshots only individually verified leaves or completely inspectable old-download folders. Unsupported, changed or excluded entries are skipped and counted.
- Cleanup cursors are opaque, single-use and valid for 30 minutes; only three inventories are retained. Previews expire after five minutes. Restarting the app clears both. New files do not enter an existing inventory. Concurrent preview jobs are rejected.
- Native OS Trash/restore, race resistance, application-aware cache rules, user-configurable cleanup ages and durable execution history remain future milestones. The current safety lock is not changed by these features.
- Browser demo uses synthetic data. Native folder selection and real saved-path behavior require the desktop app. Demo controls do not scan your filesystem.

## Validation

The regression suite exercises custom read-only scope, small-file thresholds, hidden-name filtering, exclusions, results beyond 200 groups, settings persistence/validation, job overlap/cancellation, cancellation during content hashing, manifest subset validation, cursor isolation, a 10,001-entry inventory and cleanup exclusions. Existing destructive safety and packaging tests remain enabled.

Local headless Chrome checks cover explicit group selection, preview exclusions, cancellation after navigating to another screen, the duplicate-size control and disabled removal controls. These are synthetic UI checks, not native destructive integration tests.
