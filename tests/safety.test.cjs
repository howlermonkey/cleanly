const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const { EventEmitter } = require('node:events');

const localAttributes = { spawn: () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stdin = new EventEmitter(); child.kill = () => {};
  child.stdin.end = input => queueMicrotask(() => { child.stdout.emit('data', input.split('\n').map(() => '0').join('\n')); child.emit('close', 0); });
  return child;
} };

async function fixture(t, extra = {}) {
  const workspaceFixtures = path.resolve(__dirname, '..', '.test-fixtures');
  await fsp.mkdir(workspaceFixtures, { recursive: true });
  const base = await fsp.realpath(workspaceFixtures);
  const root = await fsp.mkdtemp(path.join(base, 'evencleaner-safety-'));
  t.after(async () => {
    assert.equal(path.dirname(root), base);
    assert.ok(path.basename(root).startsWith('evencleaner-safety-'));
    await fsp.rm(root, { recursive: true, force: true });
  });
  const folders = { desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', pictures: 'Pictures', videos: 'Videos', music: 'Music', userData: 'Settings' };
  for (const name of Object.values(folders)) await fsp.mkdir(path.join(root, name));
  const effects = [];
  const electron = {
    app: { getPath: name => { if (!folders[name]) throw new Error('Unknown test folder'); return path.join(root, folders[name]); } },
    shell: { trashItem: async p => { effects.push(p); throw new Error('Real Trash is forbidden in regression tests'); } },
    safeStorage: {
      isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test',
      encryptString: s => Buffer.from('fixture-encrypted:' + s),
      decryptString: b => b.toString().slice('fixture-encrypted:'.length),
    },
  };
  const load = loadTs({ electron, 'node:os': { ...os, homedir: () => root }, ...extra });
  const write = async (relative, data = 'fixture data') => {
    const p = path.join(root, relative);
    assert.ok(p.startsWith(root + path.sep));
    await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, data); return p;
  };
  return { root, write, load, effects, electron };
}

for (const platform of ['win32', 'darwin']) {
  test(`${platform}: protect roots, app data, credentials, packages and redirection boundaries`, () => {
    const p = platform === 'win32' ? path.win32 : path.posix;
    const home = platform === 'win32' ? 'C:\\Users\\Review' : '/Users/Review';
    const redirected = platform === 'win32' ? 'D:\\Personal\\Documents' : '/Volumes/Personal/Documents';
    const roots = [p.join(home, 'Downloads'), redirected];
    const load = loadTs({ 'node:path': p, 'node:os': { homedir: () => home }, './walk': { knownFolders: () => ({ downloads: roots[0], documents: roots[1] }) } }, platform);
    const { isPersonalPath: allow } = load('electron/services/personalPolicy.ts');
    for (const input of [home, p.parse(home).root, ...roots, p.dirname(redirected), p.join(home, 'AppData/Mail/inbox.pst'),
      p.join(redirected, '.ssh/id_rsa'), p.join(redirected, '.aws/credentials'), p.join(redirected, 'mail.sqlite'),
      p.join(redirected, 'Photos.photoslibrary/original.jpg'), p.join(redirected, '../Documents-backup/a.txt'),
      p.join(home, 'Downloads/Library/a'), 'relative.txt', null]) assert.equal(allow(input), false, String(input));
    assert.equal(allow(p.join(redirected, 'vacation/photo.jpg')), true);
    assert.equal(allow(p.join(home, 'Downloads/movie.mp4')), true);
    if (platform === 'win32') for (const input of ['\\\\server\\share\\a', redirected + '\\a:secret', redirected + '\\folder.\\a']) assert.equal(allow(input), false);
    else assert.equal(allow('/volumes/Personal/Documents/a.txt'), false, 'Do not alias case-sensitive macOS volumes');
  });
}

test('production entry points remain locked before any OS side effect', async t => {
  const f = await fixture(t);
  const safety = f.load('shared/safety.ts');
  assert.equal(safety.DESTRUCTIVE_FEATURES_ENABLED, false);
  const operations = [
    () => f.load('electron/services/plans.ts').executePlan('forged-token'),
    () => f.load('electron/services/trash.ts').trashPaths([f.root]),
    () => f.load('electron/services/junk.ts').cleanJunk(['recycle-bin'], () => {}),
    () => f.load('electron/services/apps.ts').uninstallApp('forged-app'),
    () => f.load('electron/services/startup.ts').setStartup('forged-startup', false),
  ];
  for (const run of operations) await assert.rejects(run, /disabled pending safety validation/);
  assert.deepEqual(f.effects, []);
});

test('junction/symlink ancestors cannot escape a selected cache or personal folder', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'Outside'); await fsp.mkdir(outside);
  const sentinel = await f.write('Outside/precious.txt', 'must survive');
  const link = path.join(f.root, 'Downloads', 'redirect');
  await fsp.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const safety = f.load('electron/services/pathSafety.ts');
  await assert.rejects(() => safety.fileIdentity(path.join(link, 'precious.txt')), /Linked|Redirected/);
  const plans = f.load('electron/services/plans.ts');
  await assert.rejects(() => plans.previewTrash([path.join(link, 'precious.txt')]), /Linked|Redirected/);
  const walk = f.load('electron/services/walk.ts');
  const stats = await walk.walk(path.join(f.root, 'Downloads'));
  assert.equal(walk.incompleteWalk(stats), true);
  assert.equal(stats.files, 0);
  assert.equal(await fsp.readFile(sentinel, 'utf8'), 'must survive');
});

test('folder previews reject protected descendants and linked descendants', async t => {
  const f = await fixture(t);
  const folder = path.join(f.root, 'Documents', 'archive');
  await f.write('Documents/archive/.aws/credentials');
  await assert.rejects(() => f.load('electron/services/plans.ts').previewTrash([folder]), /ordinary personal/);
  await fsp.symlink(path.join(f.root, 'Pictures'), path.join(f.root, 'Downloads', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  // The Downloads root itself is never eligible.
  await assert.rejects(() => f.load('electron/services/plans.ts').previewTrash([path.join(f.root, 'Downloads')]), /ordinary personal/);
});

test('replacing an ancestor with a junction after preview rejects execution', async t => {
  const f = await fixture(t); const selected = await f.write('Downloads/selected/a.txt', 'approved');
  const sentinel = await f.write('Outside/a.txt', 'not approved');
  const p = f.load('electron/services/plans.ts'); const store = new p.PlanStore();
  const plan = store.create([await p.plannedItem(selected, 'trash')]);
  const dir = path.dirname(selected); await fsp.rename(dir, dir + '-original');
  await fsp.symlink(path.dirname(sentinel), dir, process.platform === 'win32' ? 'junction' : 'dir');
  const mutations = [];
  await assert.rejects(() => store.execute(plan.id, { validate: p.validatePlannedItem, remove: async i => mutations.push(i) }), /Linked|Redirected/);
  assert.deepEqual(mutations, []); assert.equal(await fsp.readFile(sentinel, 'utf8'), 'not approved');
});

test('unsupported filesystem entries make a folder snapshot incomplete', async t => {
  const f = await fixture(t); const dir = path.join(f.root, 'Downloads');
  const special = { name: 'socket', isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false };
  const load = loadTs({ electron: f.electron, 'node:fs': { ...fs, promises: { ...fsp,
    readdir: async (p, ...args) => p === dir ? [special] : fsp.readdir(p, ...args),
  } } });
  await assert.rejects(() => load('electron/services/plans.ts').snapshotTree(dir), /completely inspected/);
});

test('walker exposes inaccessible descendants, caps and cancellation', async t => {
  const f = await fixture(t);
  const denied = path.join(f.root, 'Downloads', 'unreadable'); await fsp.mkdir(denied);
  await f.write('Downloads/visible.txt');
  const fakeFs = { ...fs, promises: { ...fsp, readdir: async (p, ...args) => {
    if (p === denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fsp.readdir(p, ...args);
  } } };
  const load = loadTs({ electron: f.electron, 'node:fs': fakeFs });
  const w = load('electron/services/walk.ts');
  const stats = await w.walk(path.join(f.root, 'Downloads'));
  assert.equal(stats.unreadable, 1); assert.equal(w.incompleteWalk(stats), true);
  await assert.rejects(() => load('electron/services/plans.ts').snapshotTree(path.join(f.root, 'Downloads')), /completely inspected/);
  const capped = await w.walk(path.join(f.root, 'Downloads'), { maxEntries: 1, concurrency: 1 });
  assert.equal(capped.truncated, true);
  const controller = new AbortController(); controller.abort();
  assert.equal((await w.walk(f.root, { signal: controller.signal })).aborted, true);
});

test('old Downloads never approves a folder with an unreadable descendant', async t => {
  const f = await fixture(t);
  const denied = path.join(f.root, 'Downloads', 'old', 'secret'); await fsp.mkdir(denied, { recursive: true });
  await f.write('Downloads/old/visible.txt');
  const old = Date.now() - 200 * 86400000;
  const fakeFs = { ...fs, promises: { ...fsp,
    readdir: async (p, ...args) => { if (p === denied) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fsp.readdir(p, ...args); },
    lstat: async (p, options) => { const st = await fsp.lstat(p, options); if (options?.bigint) return st; return Object.assign(Object.create(st), { mtimeMs: old, birthtimeMs: old, atimeMs: old }); },
  } };
  const load = loadTs({ electron: f.electron, 'node:os': { ...os, homedir: () => f.root }, 'node:fs': fakeFs });
  const junk = load('electron/services/junk.ts');
  const result = await junk.findOldDownloads();
  assert.deepEqual(result.paths, []); assert.equal(result.incomplete, true);
  await assert.rejects(() => junk.previewJunk(['old-downloads']), /incomplete/);
});

test('preview is immutable, expiring, single-use and rejects forged tokens', async t => {
  const f = await fixture(t); const file = await f.write('Downloads/a.txt');
  const p = f.load('electron/services/plans.ts'); let now = 1000;
  const store = new p.PlanStore(() => now); const item = await p.plannedItem(file, 'trash');
  const plan = store.create([item]); plan.items[0].path = 'tampered'; item.identity.path = 'tampered';
  const removed = [];
  const adapter = { validate: p.validatePlannedItem, remove: async i => removed.push(i.identity.path) };
  await store.execute(plan.id, adapter); assert.deepEqual(removed, [file]);
  await assert.rejects(() => store.execute(plan.id, adapter), /Preview/);
  await assert.rejects(() => store.execute('forged', adapter), /Preview/);
  const expired = store.create([await p.plannedItem(file, 'trash')]); now += 300001;
  await assert.rejects(() => store.execute(expired.id, adapter), /expired/);
  assert.equal(removed.length, 1);
});

test('changing a selected file invalidates the entire manifest before mutation', async t => {
  const f = await fixture(t); const a = await f.write('Downloads/a.txt'); const b = await f.write('Downloads/b.txt');
  const p = f.load('electron/services/plans.ts'); const store = new p.PlanStore();
  const plan = store.create([await p.plannedItem(a, 'trash'), await p.plannedItem(b, 'trash')]);
  await fsp.writeFile(b, 'changed contents'); const removed = [];
  await assert.rejects(() => store.execute(plan.id, { validate: p.validatePlannedItem, remove: async i => removed.push(i) }), /Stale/);
  assert.deepEqual(removed, []);
});

test('new files after a folder preview invalidate its tree snapshot', async t => {
  const f = await fixture(t); await f.write('Downloads/collection/a.txt');
  const p = f.load('electron/services/plans.ts'); const item = await p.plannedItem(path.join(f.root, 'Downloads/collection'), 'trash');
  await f.write('Downloads/collection/new.txt');
  await assert.rejects(() => p.validatePlannedItem(item), /Stale|contents changed/);
  await assert.rejects(() => p.plannedItem(path.join(f.root, 'Downloads/collection'), 'delete'), /Permanent folder deletion/);
});

for (const change of ['missing', 'replaced', 'modified']) test(`duplicate keeper ${change} stops removal`, async t => {
  const f = await fixture(t); const data = 'same duplicate content';
  const keeper = await f.write('Documents/keeper.txt', data); const copy = await f.write('Downloads/copy.txt', data);
  const hash = crypto.createHash('sha256').update(data).digest('hex'); const p = f.load('electron/services/plans.ts');
  const plan = await p.previewDuplicates([{ hash, keeper, remove: [copy] }]);
  if (change === 'missing') await fsp.unlink(keeper);
  if (change === 'replaced') { await fsp.rename(keeper, keeper + '.old'); await fsp.writeFile(keeper, data); }
  if (change === 'modified') await fsp.writeFile(keeper, 'changed duplicate content');
  const removed = [];
  await assert.rejects(() => p.removalPlans.execute(plan.id, { validate: p.validatePlannedItem, remove: async i => removed.push(i) }));
  assert.deepEqual(removed, []); assert.equal(await fsp.readFile(copy, 'utf8'), data);
});

test('duplicate selection rejects a keeper hardlink and false content hashes', async t => {
  const f = await fixture(t); const keeper = await f.write('Documents/keeper.txt', 'same');
  const alias = path.join(f.root, 'Downloads', 'alias.txt'); await fsp.link(keeper, alias);
  const p = f.load('electron/services/plans.ts'); const hash = crypto.createHash('sha256').update('same').digest('hex');
  await assert.rejects(() => p.previewDuplicates([{ hash, keeper, remove: [alias] }]), /Keeper also selected/);
  await assert.rejects(() => p.previewDuplicates([{ hash: '0'.repeat(64), keeper, remove: [alias] }]), /contents changed/);
});

test('keeper is rechecked between removals; locked failures retain honest outcomes', async t => {
  const f = await fixture(t); const p = f.load('electron/services/plans.ts');
  const keeper = await f.write('Documents/k.txt', 'same'); const a = await f.write('Downloads/a.txt', 'same'); const b = await f.write('Downloads/b.txt', 'same');
  const hash = crypto.createHash('sha256').update('same').digest('hex');
  const plan = await p.previewDuplicates([{ hash, keeper, remove: [a, b] }]);
  const removed = [];
  const result = await p.removalPlans.execute(plan.id, { validate: p.validatePlannedItem, remove: async i => { removed.push(i.identity.path); await fsp.unlink(keeper); } });
  assert.deepEqual(removed, [a]); assert.equal(result.removed, 1); assert.equal(result.failed, 1);
  assert.equal(result.freedMeasured, false); assert.equal(result.movedToTrash, 4);
  assert.deepEqual(result.outcomes.map(i => i.status), ['removed', 'failed']);
  const store = new p.PlanStore(); const locked = store.create([await p.plannedItem(a, 'trash'), await p.plannedItem(b, 'trash')]);
  const fail = await store.execute(locked.id, { validate: p.validatePlannedItem, remove: async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } });
  assert.equal(fail.removed, 0); assert.equal(fail.failed, 2); assert.equal(fail.movedToTrash, 0);
  assert.deepEqual(fail.outcomes.map(i => i.status), ['failed', 'skipped']);
});

test('shared coordinator rejects overlapping operations and releases after failure', async () => {
  const { MutationCoordinator } = loadTs()('electron/services/mutations.ts');
  const lock = new MutationCoordinator(); let release;
  const held = lock.run('trash', () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(() => lock.run('uninstall', async () => {}), /Wait for trash/);
  release(); await held;
  await assert.rejects(() => lock.run('startup', async () => { throw new Error('failure'); }), /failure/);
  assert.equal(await lock.run('next', async () => 42), 42);
});

test('fixture-only recovery preserves content and outside sentinels', async t => {
  const f = await fixture(t); const data = crypto.randomBytes(1024);
  const selected = await f.write('Downloads/selected.bin', data); const sentinel = await f.write('Outside/keep.txt', 'untouched');
  const recovery = path.join(f.root, 'fixture-recovery'); await fsp.mkdir(recovery);
  const p = f.load('electron/services/plans.ts'); const store = new p.PlanStore(); const plan = store.create([await p.plannedItem(selected, 'trash')]);
  const dest = path.join(recovery, 'selected.bin');
  const result = await store.execute(plan.id, { validate: p.validatePlannedItem, remove: async item => { assert.equal(item.identity.path, selected); await fsp.rename(selected, dest); } });
  assert.equal(result.removed, 1); await fsp.rename(dest, selected);
  assert.deepEqual(await fsp.readFile(selected), data); assert.equal(await fsp.readFile(sentinel, 'utf8'), 'untouched');
  assert.deepEqual(f.effects, []); // This does not test the native OS Trash API.
});

test('concurrent settings and API key updates preserve unrelated changes', async t => {
  const f = await fixture(t); const s = f.load('electron/services/settings.ts');
  await Promise.all([s.setSettings({ background: 'grid' }), s.setSettings({ largeFileMinMb: 1000 }), s.setApiKey('claude', 'fixture-claude-key-123456789'), s.setApiKey('chatgpt', 'fixture-chatgpt-key-123456789')]);
  const saved = await s.getSettings(); assert.equal(saved.background, 'grid'); assert.equal(saved.largeFileMinMb, 1000);
  assert.equal(saved.hasClaudeKey, true); assert.equal(saved.hasOpenAiKey, true);
  await Promise.all([s.setApiKey('claude', null), s.setApiKey('chatgpt', 'fixture-chatgpt-new-123456789')]);
  assert.equal(await s.getApiKey('claude'), null); assert.equal(await s.getApiKey('chatgpt'), 'fixture-chatgpt-new-123456789');
  assert.equal(JSON.stringify(await s.getSettings()).includes('fixture-'), false);
});

test('failed settings persistence does not poison the queue or update cache', async t => {
  const f = await fixture(t); let fail = true;
  const disk = { ...fsp, rename: async (...args) => { if (fail) { fail = false; throw new Error('disk failure'); } return fsp.rename(...args); } };
  const load = loadTs({ electron: f.electron, 'node:fs/promises': disk }); const s = load('electron/services/settings.ts');
  await assert.rejects(() => s.setSettings({ background: 'grid' }), /disk failure/);
  assert.equal((await s.getSettings()).background, 'mist');
  assert.equal((await s.setSettings({ largeFileMinMb: 1000 })).largeFileMinMb, 1000);
});

test('AI cannot certify a known or unknown personal path as safe', () => {
  const ai = loadTs()('electron/services/ai.ts');
  const result = ai.parseAdvice({ answer: 'advice', suggestions: [{ path: '~/Documents/mail.pst', verdict: 'safe', reason: 'model says so' }, { path: '/unknown', verdict: 'safe' }, { path: '/keep', verdict: 'keep' }] }, new Set(['~/documents/mail.pst']), 'claude');
  assert.deepEqual(result.suggestions.map(s => s.verdict), ['review', 'review', 'keep']);
});

test('custom TEMP and app-data environments cannot create cleanup roots', async () => {
  const probed = [];
  const load = loadTs({ 'node:path': path.win32, 'node:os': { homedir: () => 'C:\\Users\\Review' }, 'node:fs': { ...fs, promises: { ...fsp,
    lstat: async p => { probed.push(p); throw new Error('missing fixture'); },
    readdir: async p => { probed.push(p); throw new Error('missing fixture'); },
  } } }, 'win32', { TEMP: 'D:\\Project\\tmp', TMP: 'D:\\Project\\tmp', LOCALAPPDATA: 'D:\\Project', APPDATA: 'D:\\Project', SystemRoot: 'D:\\Project', ProgramData: 'D:\\Project' });
  assert.equal(load('electron/services/junk.ts').userTempDir(), 'C:\\Users\\Review\\AppData\\Local\\Temp');
  await load('electron/services/junk.ts').scanJunk(() => {});
  assert.ok(probed.length > 0); assert.ok(probed.every(p => p.startsWith('C:\\Users\\Review\\')), JSON.stringify(probed));
  await assert.rejects(() => load('electron/services/junk.ts').previewJunk(['recycle-bin']), /Unsupported/);
  await assert.rejects(() => load('electron/services/junk.ts').previewJunk(['win-update']), /Unsupported/);
});

test('cache preview includes only inspected leaves and excludes persistent site storage', async t => {
  const f = await fixture(t);
  // Run the Windows category definitions against the native fixture filesystem on either host.
  const browserBase = process.platform === 'win32'
    ? 'AppData/Local/Google/Chrome/User Data/Default' : 'Library/Application Support/Google/Chrome/Default';
  const cache = await f.write(browserBase + '/Cache/old.bin');
  const offline = await f.write(browserBase + '/Service Worker/CacheStorage/offline.bin', 'offline content');
  const load = process.platform === 'win32' ? f.load : loadTs({ electron: f.electron, 'node:os': { ...os, homedir: () => f.root } }, 'darwin');
  const junk = load('electron/services/junk.ts'); const plans = load('electron/services/plans.ts');
  const plan = await junk.previewJunk(['browser-cache']);
  assert.deepEqual(plan.items.map(i => i.path), [cache]); assert.equal(plan.items[0].action, 'delete');
  const later = await f.write(browserBase + '/Cache/later.bin', 'not previewed');
  const removed = [];
  await plans.removalPlans.execute(plan.id, { validate: plans.validatePlannedItem, remove: async item => { removed.push(item.identity.path); } });
  assert.deepEqual(removed, [cache]); assert.equal(await fsp.readFile(offline, 'utf8'), 'offline content');
  assert.equal(await fsp.readFile(later, 'utf8'), 'not previewed');
});

test('large-file scan excludes mail, package data and credentials; partial results are disclosed', async t => {
  const f = await fixture(t); const data = Buffer.alloc(1024 * 1024, 1);
  const ordinary = await f.write('Documents/film.mp4', data);
  await f.write('Documents/mail.pst', data); await f.write('Documents/Library/data.bin', data);
  await f.write('Documents/.aws/credentials', data); await f.write('Outside/unscanned.bin', data);
  const denied = path.join(f.root, 'Pictures');
  const fakeFs = { ...fs, promises: { ...fsp, readdir: async (p, ...args) => { if (p === denied) throw new Error('denied'); return fsp.readdir(p, ...args); } } };
  const load = loadTs({ electron: f.electron, 'node:os': { ...os, homedir: () => f.root }, 'node:fs': fakeFs });
  const events = [];
  const found = await load('electron/services/largeFiles.ts').scanLargeFiles(data.length, p => events.push(p));
  assert.deepEqual(found.map(i => i.path), [ordinary]); assert.match(events.at(-1).warning, /partial/);
});

test('installer packaging hook fails closed', () => {
  const gate = require('../scripts/check-release.cjs');
  assert.throws(gate, /Packaging blocked/);
});

test('custom discovery scope finds small duplicates without widening removal permissions', async t => {
  const f = await fixture(t, { 'node:child_process': localAttributes });
  const a = await f.write('Collection/a.txt', 'identical small content');
  const b = await f.write('Collection/b.txt', 'identical small content');
  await f.write('Collection/.hidden.txt', 'identical small content');
  await f.write('Collection/mail.pst', 'identical small content');
  await f.write('Documents/outside.txt', 'identical small content');
  const options = { roots: [path.dirname(a)], exclusions: [], minBytes: 1, includeHidden: false };
  const events = []; const scan = f.load('electron/services/duplicates.ts').scanDuplicates;
  const groups = await scan(e => events.push(e), options);
  assert.equal(groups.length, 1); assert.equal(groups[0].files.length, 2);
  assert.ok(groups[0].files.every(i => i.removalEligible === false));
  assert.equal(events.at(-1).summary.matched, 1); assert.ok(events.at(-1).summary.skipped >= 2);
  await assert.rejects(() => f.load('electron/services/plans.ts').previewTrash([a]), /ordinary personal/);
  assert.equal((await scan(() => {}, { ...options, exclusions: [b] })).length, 0);
  assert.equal((await scan(() => {}, { ...options, includeHidden: true }))[0].files.length, 3);
  assert.equal((await scan(() => {}, { ...options, minBytes: 1024 })).length, 0);
});

test('duplicate scanner returns more than 200 groups and distinguishes same-size different content', async t => {
  const f = await fixture(t, { 'node:child_process': localAttributes });
  for (let i = 0; i < 201; i++) {
    const data = `content ${String(i).padStart(4, '0')}`;
    await f.write(`Documents/a-${i}.txt`, data); await f.write(`Downloads/b-${i}.txt`, data);
  }
  const events = [];
  const groups = await f.load('electron/services/duplicates.ts').scanDuplicates(e => events.push(e), {
    roots: [path.join(f.root, 'Documents'), path.join(f.root, 'Downloads')], exclusions: [], minBytes: 1, includeHidden: false,
  });
  assert.equal(groups.length, 201); assert.ok(groups.every(g => g.files.length === 2));
  assert.equal(events.at(-1).summary.limited, false);
});

test('discovery settings persist and reject unsafe roots and invalid thresholds', async t => {
  const f = await fixture(t); const settings = f.load('electron/services/settings.ts');
  const root = path.join(f.root, 'Collection'); await fsp.mkdir(root);
  const ignore = path.join(root, 'ignored');
  await settings.setSettings({ scanRoots: [root], excludedPaths: [ignore], duplicateMinBytes: 1, includeHidden: true });
  const fresh = loadTs({ electron: f.electron })('electron/services/settings.ts');
  const saved = await fresh.getSettings();
  assert.deepEqual(saved.scanRoots, [root]); assert.deepEqual(saved.excludedPaths, [ignore]); assert.equal(saved.duplicateMinBytes, 1); assert.equal(saved.includeHidden, true);
  for (const patch of [{ duplicateMinBytes: 0 }, { duplicateMinBytes: NaN }, { scanRoots: [path.parse(root).root] }, { scanRoots: [path.join(root, '.ssh')] }, { excludedPaths: ['relative'] }]) await assert.rejects(() => settings.setSettings(patch));
});

test('scan jobs cancel across callers and reject overlapping jobs of the same kind', async () => {
  const { ScanJobs, checkCancelled } = loadTs()('electron/services/scanJobs.ts'); const jobs = new ScanJobs();
  let finish; let received;
  const promise = jobs.run('dupes', async signal => { received = signal; await new Promise(r => { finish = r; }); checkCancelled(signal); });
  await assert.rejects(() => jobs.run('dupes', async () => {}), /already running/);
  assert.equal(jobs.cancel('dupes'), true); assert.equal(received.aborted, true); finish();
  await assert.rejects(() => promise, /cancelled/); assert.equal(jobs.cancel('dupes'), false);
  assert.equal(await jobs.run('dupes', async () => 123), 123);
});

test('cancelled discovery returns an explicitly partial summary without scanning files', async t => {
  const f = await fixture(t); const ctrl = new AbortController(); ctrl.abort();
  const options = { roots: [f.root], exclusions: [], minBytes: 1, includeHidden: false };
  for (const [file, run] of [['duplicates.ts', 'scanDuplicates'], ['largeFiles.ts', 'scanLargeFiles']]) {
    const events = []; const service = f.load('electron/services/' + file);
    const result = run === 'scanDuplicates' ? await service[run](e => events.push(e), options, ctrl.signal) : await service[run](1, e => events.push(e), options, ctrl.signal);
    assert.deepEqual(result, []); assert.equal(events.at(-1).summary.cancelled, true); assert.match(events.at(-1).warning, /partial/);
  }
});

test('revised previews cannot add paths, reject stale identities and invalidate the old token', async t => {
  const f = await fixture(t); const a = await f.write('Downloads/a.txt'); const b = await f.write('Downloads/b.txt');
  const p = f.load('electron/services/plans.ts'); const plan = await p.previewTrash([a,b]);
  await assert.rejects(() => p.revisePlan(plan.id, [path.join(f.root, 'Downloads/forged')]), /cannot add/);
  const revised = await p.revisePlan(plan.id, [a]); assert.deepEqual(revised.items.map(i => i.path), [a]);
  await assert.rejects(() => p.revisePlan(plan.id, [a]), /expired/);
  await fsp.writeFile(a, 'changed'); await assert.rejects(() => p.revisePlan(revised.id, [a]), /Stale/);
  const another = await p.previewTrash([b]);
  assert.deepEqual((await p.revisePlan(another.id, [])).items, []);
  await assert.rejects(() => p.revisePlan(another.id, [b]), /expired/);
});

test('cleanup batching processes large inventories with disjoint single-use pages and saved exclusions', async t => {
  const f = await fixture(t); const recorded = [];
  const adapter = { plannedItem: async (p, action) => ({ identity: { path: p, size: 1, directory: false }, action }), removalPlans: { create: (items, _keepers, batch) => { recorded.push(items); return { id: 'test', items: items.map(i => ({ path: i.identity.path })), batch }; } } };
  const load = loadTs({ './plans': adapter }); const batches = load('electron/services/cleanupBatches.ts');
  const inventory = Array.from({ length: 10001 }, (_,i) => ({ path: path.join(f.root, `file-${i}.tmp`), action: 'delete' }));
  const cursor = batches.startCleanupBatches(inventory, ['browser-cache'], false);
  inventory[0].path = 'tampered';
  const first = await batches.nextCleanupBatch(cursor, ['browser-cache'], []);
  assert.equal(first.items.length, 500); assert.equal(first.batch.remaining, 9501); assert.notEqual(first.items[0].path, 'tampered');
  await assert.rejects(() => batches.nextCleanupBatch(cursor, ['browser-cache'], []), /expired/);
  const ignored = path.join(f.root, 'file-500.tmp');
  const second = await batches.nextCleanupBatch(first.batch.cursor, ['browser-cache'], [ignored]);
  assert.equal(second.items.length, 500); assert.equal(second.batch.skipped, 1);
  assert.ok(second.items.every(i => !first.items.some(j => i.path === j.path) && i.path !== ignored));
  assert.equal(recorded.length, 2);
});

test('cleanup exclusions affect scan totals and exact preview candidates', async t => {
  const f = await fixture(t);
  const root = process.platform === 'win32' ? 'AppData/Local/Google/Chrome/User Data/Default/Cache' : 'Library/Application Support/Google/Chrome/Default/Cache';
  const keep = await f.write(root + '/keep.bin', 'keep'); const candidate = await f.write(root + '/candidate.bin', 'candidate');
  const load = process.platform === 'win32' ? f.load : loadTs({ electron: f.electron, 'node:os': { ...os, homedir: () => f.root } }, 'darwin');
  const junk = load('electron/services/junk.ts');
  const result = await junk.scanJunk(() => {}, [keep]);
  assert.equal(result.find(c => c.id === 'browser-cache').size, Buffer.byteLength('candidate'));
  const plan = await junk.previewJunk(['browser-cache'], undefined, [keep]);
  assert.deepEqual(plan.items.map(i => i.path), [candidate]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => junk.previewJunk(['browser-cache'], undefined, [], controller.signal), /cancelled/);
});

test('cancellation interrupts content hashing and reports partial duplicate results', async t => {
  const ctrl = new AbortController(); let streams = 0;
  const f = await fixture(t, { 'node:child_process': localAttributes, 'node:fs': { ...fs, createReadStream: (p, options) => {
    streams++; const stream = fs.createReadStream(p, options); stream.once('data', () => ctrl.abort()); return stream;
  } } });
  await f.write('Downloads/a.bin', Buffer.alloc(256 * 1024, 1)); await f.write('Documents/b.bin', Buffer.alloc(256 * 1024, 1));
  const events = [];
  await f.load('electron/services/duplicates.ts').scanDuplicates(p => events.push(p), {
    roots: [path.join(f.root, 'Downloads'), path.join(f.root, 'Documents')], exclusions: [], minBytes: 1, includeHidden: false,
  }, ctrl.signal);
  assert.ok(streams > 0); assert.equal(events.at(-1).summary.cancelled, true); assert.equal(events.at(-1).summary.partial, true);
});

test('later exclusions inside an old-download folder prevent that folder entering a cleanup batch', async t => {
  const f = await fixture(t); const folder = path.join(f.root, 'Downloads/archive');
  const child = await f.write('Downloads/archive/important.txt'); const file = await f.write('Downloads/other.txt');
  const batches = f.load('electron/services/cleanupBatches.ts');
  const cursor = batches.startCleanupBatches([{ path: folder, action: 'trash' }, { path: file, action: 'trash' }], ['old-downloads'], false);
  const result = await batches.nextCleanupBatch(cursor, ['old-downloads'], [child]);
  assert.equal(result.batch.skipped, 1); assert.deepEqual(result.items.map(i => i.path), [file]);
});

test('space-map cancellation exits before invoking disk services', async t => {
  const f = await fixture(t); const ctrl = new AbortController(); ctrl.abort();
  await assert.rejects(() => f.load('electron/services/spaces.ts').scanSpaces(() => {}, undefined, ctrl.signal), /cancelled/);
});
