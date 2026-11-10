import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { Catalog, revision } from '../app/catalog.mjs';
import { Workspace } from '../app/workspace.mjs';
import { Library } from '../app/library.mjs';
import { Device } from '../app/device.mjs';
import { fingerprint, prepare } from '../app/archive.mjs';
import { mediaResponse } from '../app/media.mjs';
import { newerVersion, checkUpdate } from '../app/updates.mjs';
import { FileEstimate } from '../app/progress-estimate.mjs';
import { ensureDeviceMarker } from '@studio-pocket/sync-engine/node';
import { checkLibrary } from '@studio-pocket/library-format/node';
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-studio-')),
    inbox = path.join(root, 'Inbox'),
    folder = path.join(inbox, 'A story'),
    volume = path.join(root, 'Player');
  await fs.mkdir(path.join(folder, 'audio'), { recursive: true });
  await fs.mkdir(path.join(folder, 'icons'));
  await fs.mkdir(volume);
  await ensureDeviceMarker(volume, 'tests');
  await fs.copyFile(
    'vendor/library-format/fixtures/audio/tone-c5.mp3',
    path.join(folder, 'audio', '01.mp3'),
  );
  await fs.copyFile(
    'vendor/library-format/fixtures/audio/tone-g5.mp3',
    path.join(folder, 'audio', '02.mp3'),
  );
  for (const [name, color] of [
    ['one', '#ff0000'],
    ['two', '#0000ff'],
  ])
    await sharp({ create: { width: 16, height: 16, channels: 4, background: color } })
      .png()
      .toFile(path.join(folder, 'icons', name + '.png'));
  await fs.writeFile(
    path.join(folder, 'metadata.json'),
    JSON.stringify({
      format: 'myo-studio-archive',
      title: 'A story',
      tracks: [
        { index: 0, title: 'One', audio: 'audio/01.mp3', icon: 'icons/one.png' },
        { index: 1, title: 'Two', audio: 'audio/02.mp3', icon: 'icons/two.png' },
      ],
    }),
  );
  const old = new Date(Date.now() - 10000);
  await fs.utimes(folder, old, old);
  const catalog = await new Catalog(path.join(root, 'support')).load(),
    device = new Device(volume, async (p) => {
      const s = await fs.lstat(p);
      return { dev: s.dev, ino: s.ino };
    }),
    library = new Library({ inbox, device, catalog }),
    workspace = new Workspace(library, catalog);
  await library.scan();
  return {
    root,
    inbox,
    folder,
    volume,
    catalog,
    device,
    library,
    workspace,
    cleanup: async () => {
      await workspace.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
test('track edits reorder, rename, reassign icons, persist across refresh/reopen and update the same player identity', async () => {
  const s = await setup();
  try {
    const before = await fingerprint(s.folder),
      key = s.library.rows[0].key,
      originalId = s.library.rows[0].id,
      doc = await s.workspace.open(key);
    const tracks = [
      { ...doc.tracks[1], title: 'New opening', iconKey: 'icons/one.png' },
      { ...doc.tracks[0], title: 'New ending', iconKey: 'icons/two.png' },
    ];
    await s.workspace.save(doc.id, { ...doc, title: 'Renamed story', tags: ['Bedtime'], tracks });
    assert.equal(s.library.rows[0].title, 'Renamed story');
    assert.equal(s.library.rows[0].id, originalId);
    assert.deepEqual(s.library.rows[0].tags, ['Bedtime']);
    await s.library.transfer([key], 'sync', s.library.deviceState.deviceId);
    const check = await checkLibrary(s.device.root, { verifyHashes: true }),
      playlist = check.playlists[0];
    assert.equal(playlist.id, originalId);
    assert.deepEqual(
      playlist.manifest.tracks.map((t) => t.title),
      ['New opening', 'New ending'],
    );
    assert.equal(playlist.manifest.title, 'Renamed story');
    const iconFile = path.join(
      s.device.root,
      'playlists',
      originalId,
      playlist.manifest.tracks[0].icon,
    );
    assert.deepEqual(
      await fs.readFile(iconFile),
      await fs.readFile(path.join(s.folder, 'icons', 'one.png')),
    );
    assert.equal(await fingerprint(s.folder), before);
    const reloaded = await new Catalog(s.catalog.folder).load();
    assert.equal(reloaded.get(key).edits.tracks[0].key, 'audio/02.mp3');
    assert.equal(reloaded.get(key).syncedRevision, revision(reloaded.get(key).edits));
    await s.library.scan(true);
    assert.equal(s.library.rows[0].edited, false);
    await s.library.transfer([key], 'sync', s.library.deviceState.deviceId);
    assert.equal(s.library.lastResult.counts.unchanged, 1);
    const reopened = await s.workspace.open(key);
    assert.equal(reopened.tracks[0].title, 'New opening');
    assert.equal(reopened.tracks[0].iconKey, 'icons/one.png');
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#aabbcc' } })
      .png()
      .toFile(path.join(s.folder, 'icons', 'one.png'));
    await s.library.scan(true);
    await s.library.scan(true);
    assert.equal(s.library.rows[0].edited, true);
    assert.equal(s.library.rows[0].status, 'update');
    await s.library.transfer([key], 'sync', s.library.deviceState.deviceId);
    assert.equal(s.library.rows[0].edited, false);
    assert.deepEqual(
      await fs.readFile(iconFile),
      await fs.readFile(path.join(s.folder, 'icons', 'one.png')),
    );
  } finally {
    await s.cleanup();
  }
});
test('excluded unsupported tracks never convert or sync; originals remain, and every track cannot be excluded', async () => {
  const s = await setup();
  try {
    await fs.writeFile(
      path.join(s.folder, 'audio', '03.opus'),
      'invalid opus deliberately excluded',
    );
    const meta = JSON.parse(await fs.readFile(path.join(s.folder, 'metadata.json')));
    meta.tracks.push({ index: 2, title: 'Skip me', audio: 'audio/03.opus' });
    await fs.writeFile(path.join(s.folder, 'metadata.json'), JSON.stringify(meta));
    await s.library.scan(true);
    await s.library.scan(true);
    const row = s.library.rows[0],
      doc = await s.workspace.open(row.key);
    const tracks = doc.tracks.map((t) => ({ ...t, excluded: t.key.endsWith('.opus') }));
    await s.workspace.save(doc.id, { ...doc, tracks });
    s.library.convertOpus = true;
    s.library.conversionOptions.encode = () => {
      throw new Error('Excluded audio must not encode');
    };
    await s.library.transfer([row.key], 'sync', s.library.deviceState.deviceId);
    assert.equal((await checkLibrary(s.device.root)).playlists[0].manifest.tracks.length, 2);
    assert.ok(await fs.stat(path.join(s.folder, 'audio', '03.opus')));
    const next = await s.workspace.open(row.key);
    await assert.rejects(
      s.workspace.save(next.id, {
        ...next,
        tracks: next.tracks.map((t) => ({ ...t, excluded: true })),
      }),
      /at least one/,
    );
    await assert.rejects(
      s.workspace.save(next.id, {
        ...next,
        tracks: next.tracks.map((t, i) => (i ? t : { ...t, iconKey: '../../private.png' })),
      }),
      /Choose an icon/,
    );
  } finally {
    await s.cleanup();
  }
});
test('player collections preserve unrelated groups and listening history, update order, reject wrong device and duplicate membership', async () => {
  const s = await setup();
  try {
    const recent = path.join(s.device.root, 'recent.json');
    await fs.writeFile(recent, 'keep listening history');
    await s.device.saveGroups([
      { id: 'other', title: 'Existing', icon: null, playlists: ['a-story', 'another-book'] },
    ]);
    const ours = [{ id: 'pd-bedtime', title: 'Bedtime', icon: null, playlists: ['a-story'] }];
    await s.catalog.groups(ours);
    await s.device.saveGroups(ours, {
      ownedIds: s.catalog.data.ownedGroups,
      expectedDeviceId: s.library.deviceState.deviceId,
    });
    const groups = JSON.parse(await fs.readFile(path.join(s.device.root, 'groups.json'))).groups;
    assert.deepEqual(
      groups.map((g) => g.id),
      ['other', 'pd-bedtime'],
    );
    assert.deepEqual(groups[0].playlists, ['another-book']);
    assert.equal(await fs.readFile(recent, 'utf8'), 'keep listening history');
    await assert.rejects(s.device.saveGroups(ours, { expectedDeviceId: 'wrong' }), /changed/);
    await assert.rejects(
      s.catalog.groups([
        ...ours,
        { id: 'pd-other', title: 'Other', icon: null, playlists: ['a-story'] },
      ]),
      /already in group/,
    );
    await s.catalog.groups([]);
    await s.device.saveGroups([], { ownedIds: s.catalog.data.ownedGroups });
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(s.device.root, 'groups.json'))).groups.map(
        (g) => g.id,
      ),
      ['other'],
    );
    await fs.writeFile(path.join(s.device.root, 'sync.lock'), 'another operation');
    await assert.rejects(s.device.saveGroups([]), /EEXIST/);
    assert.equal(
      await fs.readFile(path.join(s.device.root, 'sync.lock'), 'utf8'),
      'another operation',
    );
  } finally {
    await s.cleanup();
  }
});
test('offline preparation is independent of device busy state and removal undo restores only the same unchanged source/player', async () => {
  const s = await setup();
  try {
    const key = s.library.rows[0].key,
      id = s.library.deviceState.deviceId;
    s.library.deviceState = { connected: false };
    await s.workspace.prepareAudio([key]);
    assert.equal(s.library.busy, false);
    assert.ok(s.library.preparation.running);
    await s.workspace.preparingTask;
    assert.equal(s.library.preparation.phase, 'Audio is ready to sync');
    assert.ok(s.catalog.get(key).prepared);
    await s.library.scan(true);
    await s.library.transfer([key], 'sync', id);
    assert.equal(s.library.rows[0].prepared, true);
    await s.library.transfer([key], 'remove', id);
    assert.ok(s.catalog.data.undo.items.length);
    await s.workspace.undoRemoval();
    assert.equal((await checkLibrary(s.device.root)).playlists.length, 1);
    assert.equal(s.catalog.data.undo, null);
    await s.library.transfer([key], 'remove', id);
    s.library.deviceState.deviceId = 'different';
    await assert.rejects(s.workspace.undoRemoval(), /same Pocket/);
    s.library.deviceState.deviceId = id;
    await fs.appendFile(path.join(s.folder, 'audio', '01.mp3'), 'changed');
    await assert.rejects(s.workspace.undoRemoval(), /changed since/);
  } finally {
    await s.cleanup();
  }
});
test('preview media supports seeking and rejects invalid ranges/methods', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-media-'));
  try {
    const file = path.join(root, 'test.mp3');
    await fs.writeFile(file, '0123456789');
    let r = await mediaResponse(
      file,
      new Request('https://local', { headers: { range: 'bytes=2-5' } }),
    );
    assert.equal(r.status, 206);
    assert.equal(await r.text(), '2345');
    assert.equal(r.headers.get('Content-Range'), 'bytes 2-5/10');
    r = await mediaResponse(file, new Request('https://local', { headers: { range: 'bytes=-3' } }));
    assert.equal(await r.text(), '789');
    assert.equal(
      (
        await mediaResponse(
          file,
          new Request('https://local', { headers: { range: 'bytes=20-30' } }),
        )
      ).status,
      416,
    );
    assert.equal(
      (await mediaResponse(file, new Request('https://local', { method: 'POST' }))).status,
      405,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('changed originals reject stale edits; duplicate comparison distinguishes audio and hidden copies stay separate', async () => {
  const s = await setup();
  try {
    let doc = await s.workspace.open(s.library.rows[0].key);
    await fs.appendFile(path.join(s.folder, 'audio', '01.mp3'), 'changed');
    await assert.rejects(s.workspace.save(doc.id, doc), /original files changed/);
    assert.equal(s.catalog.get(doc.rowKey).edits, undefined);
    await s.workspace.editor.closeAll();
    await fs.copyFile(
      'vendor/library-format/fixtures/audio/tone-c5.mp3',
      path.join(s.folder, 'audio', '01.mp3'),
    );
    const other = path.join(s.inbox, 'Second copy');
    await fs.cp(s.folder, other, { recursive: true });
    const old = new Date(Date.now() - 10000);
    await fs.utimes(other, old, old);
    await s.library.scan(true);
    await s.library.scan(true);
    const keys = s.library.rows.map((r) => r.key);
    assert.equal(keys.length, 2);
    let comparison = await s.workspace.compareDuplicates(keys);
    assert.ok(comparison.items.every((i) => i.comparison.startsWith('Identical audio')));
    await fs.copyFile(
      'vendor/library-format/fixtures/audio/tone-c5.mp3',
      path.join(other, 'audio', '02.mp3'),
    );
    comparison = await s.workspace.compareDuplicates(keys);
    assert.ok(comparison.items[1].comparison.includes('Different audio'));
    await s.library.scan(true);
    await s.library.scan(true);
    await s.catalog.set(keys[0], { hidden: true });
    for (const cached of s.library.cache.values()) cached.row.content = 'same-content';
    await s.library.scan(true);
    assert.equal(s.library.rows.length, 2);
    assert.equal(s.library.rows.filter((r) => !r.hidden).length, 1);
  } finally {
    await s.cleanup();
  }
});
test('media preview refuses a parent folder replaced by a symbolic link', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-preview-guard-'));
  try {
    const source = path.join(root, 'source'),
      outside = path.join(root, 'outside');
    await fs.mkdir(source);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(source, '01.mp3'), 'approved');
    await fs.writeFile(path.join(outside, '01.mp3'), 'private');
    await fs.rename(source, source + '-old');
    await fs.symlink(outside, source);
    const response = await mediaResponse(path.join(source, '01.mp3'), new Request('https://local'));
    assert.equal(response.status, 404);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('update checks compare semantic versions, select the correct Mac asset, bound responses and reject foreign download links', async () => {
  assert.equal(newerVersion('v4.10.0', '4.9.9'), true);
  assert.equal(newerVersion('4.3.1', '4.4.0'), false);
  assert.equal(newerVersion('bad', '4.4.0'), false);
  assert.equal((await checkUpdate('', '4.4.0', 'x64')).status, 'unconfigured');
  const payload = {
    tag_name: 'v4.5.0',
    body: 'Changes',
    assets: [
      {
        name: 'Pocket-Drop-4.5.0-mac-x64.zip',
        browser_download_url: 'https://github.com/test/repo/releases/download/v4.5.0/intel.zip',
      },
      {
        name: 'Pocket-Drop-4.5.0-mac-arm64.zip',
        browser_download_url: 'https://github.com/test/repo/releases/download/v4.5.0/arm.zip',
      },
    ],
  };
  let result = await checkUpdate('test/repo', '4.4.0', 'arm64', {
    fetcher: async () => Response.json(payload),
  });
  assert.equal(result.status, 'available');
  assert.ok(result.url.endsWith('/arm.zip'));
  payload.assets[0].browser_download_url = 'https://foreign.example/file';
  await assert.rejects(
    checkUpdate('test/repo', '4.4.0', 'x64', { fetcher: async () => Response.json(payload) }),
    /Unexpected/,
  );
  await assert.rejects(
    checkUpdate('test/repo', '4.4.0', 'x64', {
      fetcher: async () => new Response('a'.repeat(1024 ** 2 + 1)),
    }),
    /too large/,
  );
});
test('conversion estimates wait for a completed encode and cache hits do not create fake timing samples', () => {
  let now = 0;
  const estimate = new FileEstimate(3, () => now);
  assert.equal(estimate.update('one', 'Decoding Opus'), null);
  now = 10000;
  assert.equal(estimate.update('one', 'Encoding AAC'), null);
  now = 40000;
  assert.equal(estimate.update('one', 'AAC ready'), 120000);
  now = 41000;
  assert.equal(estimate.update('two', 'Using converted audio'), 81000);
  now = 42000;
  assert.equal(estimate.update('two', 'Using converted audio'), 81000);
  estimate.update('three', 'Decoding Opus');
  now = 120000;
  assert.equal(estimate.update('three', 'AAC ready'), null);
});
test('a failed edit save retains the last saved version in memory and on disk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-save-failure-'));
  try {
    const catalog = await new Catalog(root).load();
    await catalog.set('book', { tags: ['Original'] });
    const original = fs.writeFile;
    fs.writeFile = async () => {
      throw new Error('Disk is full');
    };
    try {
      await assert.rejects(catalog.set('book', { tags: ['Unsaved'] }), /Disk is full/);
    } finally {
      fs.writeFile = original;
    }
    assert.deepEqual(catalog.get('book').tags, ['Original']);
    assert.deepEqual((await new Catalog(root).load()).get('book').tags, ['Original']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Sync Collections sends missing audio and pictures, preserves history and one membership', async () => {
  const s = await setup();
  try {
    const icon = 'asset:11111111-1111-1111-1111-111111111111.png';
    await fs.mkdir(path.join(s.catalog.folder, 'artwork'));
    await fs.copyFile(path.join(s.folder, 'icons/one.png'), s.workspace.editor.asset(icon));
    await s.catalog.groups(
      [{ id: 'pd-series', title: 'Series', icon: 'groups/pd-series.png', playlists: ['a-story'] }],
      { 'pd-series': { iconRef: icon } },
    );
    await fs.writeFile(path.join(s.device.root, 'recent.json'), 'preserved');
    const plan = s.workspace.collectionPlan();
    assert.equal(plan.keys.length, 1);
    await s.workspace.syncCollections(plan);
    const check = await checkLibrary(s.device.root, { verifyHashes: true });
    assert.ok(check.playlists[0].ok);
    assert.equal(await fs.readFile(path.join(s.device.root, 'recent.json'), 'utf8'), 'preserved');
    assert.equal(
      (await fs.readFile(path.join(s.device.root, 'groups/pd-series.png'))).length,
      (await fs.readFile(s.workspace.editor.asset(icon))).length,
    );
    assert.equal(s.workspace.collectionPlan().keys.length, 0);
    assert.ok((await s.device.inspect()).audioDurationMs > 0);
    await s.catalog.groups([
      { id: 'pd-missing', title: 'Missing', icon: null, playlists: ['absent'] },
    ]);
    assert.throws(() => s.workspace.collectionPlan(), /original/);
  } finally {
    await s.cleanup();
  }
});
test('duplicate results persist and reuse fingerprints without rereading unchanged audio', async () => {
  const s = await setup();
  try {
    const other = path.join(s.inbox, 'Other');
    await fs.cp(s.folder, other, { recursive: true });
    const old = new Date(Date.now() - 10000);
    await fs.utimes(other, old, old);
    await s.library.scan(true);
    await s.library.scan(true);
    const keys = s.library.rows.map((r) => r.key);
    await s.workspace.compareDuplicates(keys, { useCache: true });
    const original = fs.open;
    fs.open = async (file, ...args) => {
      if (/\.mp3$/i.test(String(file))) throw new Error('Repeated audio read forbidden');
      return original(file, ...args);
    };
    try {
      const result = await s.workspace.compareDuplicates(keys, { useCache: true });
      assert.ok(result.items.every((i) => i.comparison.startsWith('Identical')));
    } finally {
      fs.open = original;
    }
    const reload = await new Catalog(s.catalog.folder).load();
    assert.equal(Object.keys(reload.data.duplicateChecks).length, 2);
  } finally {
    await s.cleanup();
  }
});

test('opening archive details extracts no audio; preview extracts only the requested track', async () => {
  const s = await setup();
  try {
    const { default: yazl } = await import('yazl'),
      { createWriteStream } = await import('node:fs'),
      { pipeline } = await import('node:stream/promises'),
      { tree } = await import('../app/archive.mjs');
    const zip = new yazl.ZipFile();
    for (const file of await tree(s.folder)) zip.addFile(path.join(s.folder, file.name), file.name);
    zip.end();
    const archive = path.join(s.inbox, 'A story.zip');
    await pipeline(zip.outputStream, createWriteStream(archive));
    const { quickDocument } = await import('../app/editor.mjs');
    const doc = await quickDocument(archive);
    try {
      assert.equal(doc.root, null);
      assert.equal(doc.tracks.length, 2);
      const preview = await doc.file(doc.tracks[0].key);
      assert.ok((await fs.stat(preview)).size > 0);
      assert.equal(
        await fs.stat(path.join(path.dirname(preview), '02.mp3')).catch(() => null),
        null,
      );
    } finally {
      await doc.cleanup();
    }
  } finally {
    await s.cleanup();
  }
});
test('large file copy keeps the event loop responsive, bounds USB metadata checks and reports verification', async () => {
  const s = await setup();
  let timer;
  try {
    const p = await prepare(s.folder);
    try {
      const big = path.join(s.root, 'large-test.mp3'),
        handle = await fs.open(big, 'w');
      await handle.truncate(64 * 1024 ** 2);
      await handle.write(await fs.readFile('vendor/library-format/fixtures/audio/tone-c5.mp3'), 0);
      await handle.close();
      const { createHash } = await import('node:crypto'),
        { createReadStream } = await import('node:fs');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(big)) hash.update(chunk);
      const track = p.playlist.tracks[0];
      track.localPath = big;
      track.entry.sizeBytes = 64 * 1024 ** 2;
      track.entry.sha256 = hash.digest('hex');
      p.playlist.manifest.tracks = p.playlist.tracks.map((t) => t.entry);
      let ticks = 0,
        reads = 0;
      timer = setInterval(() => ticks++, 2);
      const original = fs.readFile;
      fs.readFile = async (file, ...args) => {
        if (String(file) === path.join(s.device.root, 'device.json')) reads++;
        return original(file, ...args);
      };
      const progress = [];
      try {
        await s.device.execute({ send: [p.playlist], onProgress: (event) => progress.push(event) });
      } finally {
        fs.readFile = original;
      }
      assert.ok(ticks > 0);
      assert.ok(reads < 300, `Too many USB marker reads: ${reads}`);
      assert.ok(progress.some((e) => e.phase === 'verify' && e.fileBytesTotal === 64 * 1024 ** 2));
      assert.ok((await checkLibrary(s.device.root, { verifyHashes: true })).playlists[0].ok);
    } finally {
      await p.cleanup();
    }
  } finally {
    clearInterval(timer);
    await s.cleanup();
  }
});
test('metadata refresh leaves a long duplicate comparison running; device operations pause it', async () => {
  const s = await setup();
  try {
    const abort = new AbortController();
    s.workspace.duplicateAbort = abort;
    s.workspace.duplicateTask = Promise.resolve();
    s.library.refreshing = true;
    s.workspace.scheduleDuplicates();
    assert.equal(abort.signal.aborted, false);
    s.library.busy = true;
    s.workspace.scheduleDuplicates();
    assert.equal(abort.signal.aborted, true);
    s.library.busy = false;
    s.library.refreshing = false;
  } finally {
    await s.cleanup();
  }
});
test('device metadata is cached by index checksum and manual refresh rereads it', async () => {
  const s = await setup();
  const original = fs.readFile;
  try {
    await s.library.transfer([s.library.rows[0].key], 'sync', s.library.deviceState.deviceId);
    let reads = 0;
    fs.readFile = async (file, ...args) => {
      if (String(file).endsWith('/manifest.json')) reads++;
      return original(file, ...args);
    };
    await s.device.inspect();
    assert.equal(reads, 0);
    await s.device.inspect({ fresh: true });
    assert.equal(reads, 1);
  } finally {
    fs.readFile = original;
    await s.cleanup();
  }
});

test('resync safely repairs a missing player manifest and preserves unrelated audio/history', async () => {
  const s = await setup();
  try {
    const key = s.library.rows[0].key;
    const extra = await prepare(s.folder);
    try {
      await s.device.execute({
        send: [
          {
            ...extra.playlist,
            manifest: { ...extra.playlist.manifest, id: 'unrelated', title: 'Other book' },
          },
        ],
      });
    } finally {
      await extra.cleanup();
    }
    const otherFile = path.join(s.device.root, 'playlists', 'unrelated', 'manifest.json'),
      otherBefore = await fs.readFile(otherFile);
    await s.library.transfer([key], 'sync');
    const sourceHash = await fingerprint(s.folder),
      state = path.join(s.device.root, 'state', 'a-story.json');
    await fs.writeFile(state, 'saved listening position');
    const manifest = path.join(s.device.root, 'playlists', 'a-story', 'manifest.json');
    await fs.rm(manifest);
    await s.library.scan(true);
    assert.equal(s.library.rows[0].onDevice, false);
    assert.equal(s.library.rows[0].status, 'ready');
    await s.library.transfer([key], 'sync');
    assert.ok((await checkLibrary(s.device.root, { verifyHashes: true })).playlists[0].ok);
    assert.equal((await checkLibrary(s.device.root)).playlists.length, 2);
    assert.deepEqual(await fs.readFile(otherFile), otherBefore);
    assert.equal(await fs.readFile(state, 'utf8'), 'saved listening position');
    assert.equal(await fingerprint(s.folder), sourceHash);
  } finally {
    await s.cleanup();
  }
});
test('normal Sync copies collection changes, supports metadata-only sync and leaves unselected audio alone', async () => {
  const s = await setup();
  try {
    const key = s.library.rows[0].key,
      id = s.library.deviceState.deviceId;
    await s.catalog.groups([
      { id: 'pd-series', title: 'Series', icon: null, playlists: ['a-story', 'future-book'] },
    ]);
    assert.equal(s.library.snapshot().collectionSyncNeeded, true);
    await s.workspace.syncAudio([key], id);
    assert.equal(s.library.snapshot().collectionSyncNeeded, false);
    assert.equal((await checkLibrary(s.device.root)).playlists.length, 1);
    let groups = JSON.parse(await fs.readFile(path.join(s.device.root, 'groups.json'))).groups;
    assert.deepEqual(groups[0].playlists, ['a-story', 'future-book']);
    await s.catalog.groups([{ ...groups[0], title: 'Renamed series' }]);
    assert.equal(s.library.snapshot().collectionSyncNeeded, true);
    const transfer = s.library.transfer;
    s.library.transfer = () => {
      throw new Error('Metadata-only sync must not transfer audio');
    };
    try {
      await s.workspace.syncAudio([], id);
    } finally {
      s.library.transfer = transfer;
    }
    groups = JSON.parse(await fs.readFile(path.join(s.device.root, 'groups.json'))).groups;
    assert.equal(groups[0].title, 'Renamed series');
    assert.equal(s.library.lastResult.message, 'Collections synced to Pocket.');
    assert.equal(s.library.snapshot().busy, false);
    assert.equal(s.library.snapshot().collectionSyncNeeded, false);
  } finally {
    await s.cleanup();
  }
});
test('collection failure after audio succeeds reports partial success and releases all controls', async () => {
  const s = await setup();
  try {
    const key = s.library.rows[0].key,
      id = s.library.deviceState.deviceId;
    await s.catalog.groups([
      { id: 'pd-series', title: 'Series', icon: null, playlists: ['a-story'] },
    ]);
    s.device.saveGroups = async () => {
      throw new Error('Player disconnected before collections');
    };
    await assert.rejects(s.workspace.syncAudio([key], id), /disconnected/);
    assert.equal(s.library.lastResult.message, 'Audio sync finished; collections need attention');
    assert.equal(s.library.snapshot().busy, false);
    assert.equal(s.workspace.syncingCollections, false);
    assert.ok((await checkLibrary(s.device.root, { verifyHashes: true })).playlists[0].ok);
  } finally {
    await s.cleanup();
  }
});
test('cancel between audio and collection stages keeps transferred audio and leaves collection changes pending', async () => {
  const s = await setup();
  try {
    const key = s.library.rows[0].key,
      id = s.library.deviceState.deviceId;
    await s.catalog.groups([
      { id: 'pd-series', title: 'Series', icon: null, playlists: ['a-story'] },
    ]);
    const cancel = (state) => {
      if (state.progress?.phase === 'Syncing collections') s.library.cancelled = true;
    };
    s.library.on('change', cancel);
    await assert.rejects(s.workspace.syncAudio([key], id), /cancelled/);
    s.library.off('change', cancel);
    assert.equal(s.library.snapshot().busy, false);
    assert.equal(s.library.snapshot().collectionSyncNeeded, true);
    assert.ok((await checkLibrary(s.device.root, { verifyHashes: true })).playlists[0].ok);
    assert.equal(await fs.stat(path.join(s.device.root, 'groups.json')).catch(() => null), null);
  } finally {
    await s.cleanup();
  }
});
test('editor shows track sizes immediately, measures lengths asynchronously and reuses cached measurements', async () => {
  const s = await setup();
  try {
    const key = s.library.rows[0].key,
      before = await fingerprint(s.folder);
    let doc = await s.workspace.open(key);
    assert.ok(doc.tracks.every((t) => t.size > 0));
    assert.ok(doc.tracks.every((t) => t.durationMs === null));
    let metrics = s.workspace.editor.metrics(doc.id);
    assert.ok(metrics.running);
    await s.workspace.editor.session(doc.id).metricsTask;
    metrics = s.workspace.editor.metrics(doc.id);
    assert.equal(metrics.running, false);
    assert.ok(metrics.tracks.every((t) => t.durationMs > 0 && t.size > 0));
    const cached = s.catalog.get(key).durations;
    assert.equal(cached.complete, true);
    assert.equal(await fingerprint(s.folder), before);
    s.workspace.editor.probe = () => {
      throw new Error('Cached track lengths must not probe audio again');
    };
    doc = await s.workspace.open(key);
    assert.ok(doc.tracks.every((t) => t.durationMs > 0));
    s.workspace.editor.metrics(doc.id);
    await s.workspace.editor.session(doc.id).metricsTask;
    assert.equal(s.workspace.editor.metrics(doc.id).error, null);
  } finally {
    await s.cleanup();
  }
});
test('closing track details aborts pending metrics without changing originals or keeping an editor session', async () => {
  const s = await setup();
  let finish;
  try {
    const key = s.library.rows[0].key,
      doc = await s.workspace.open(key),
      session = s.workspace.editor.session(doc.id),
      before = await fingerprint(s.folder);
    let entered;
    const ready = new Promise((resolve) => (entered = resolve)),
      gate = new Promise((resolve) => (finish = resolve));
    s.workspace.editor.probe = async () => {
      entered();
      await gate;
      return 1234;
    };
    s.workspace.editor.metrics(doc.id);
    await ready;
    await s.workspace.editor.close(doc.id);
    assert.equal(s.workspace.editor.sessions.size, 0);
    assert.ok(session.metricsAbort.signal.aborted);
    finish();
    await session.metricsTask;
    assert.equal(s.catalog.get(key).durations, undefined);
    assert.equal(await fingerprint(s.folder), before);
  } finally {
    finish?.();
    await s.cleanup();
  }
});

test('overlapping detail opens leave exactly one active session', async () => {
  const s = await setup();
  try {
    const key = s.library.rows[0].key;
    const outcomes = await Promise.allSettled([s.workspace.open(key), s.workspace.open(key)]);
    assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((r) => r.status === 'rejected').length, 1);
    assert.equal(s.workspace.editor.sessions.size, 1);
  } finally {
    await s.cleanup();
  }
});
test('shutdown drains late metric jobs and prevents writes after cleanup finishes', async () => {
  const s = await setup();
  let release;
  try {
    const doc = await s.workspace.open(s.library.rows[0].key);
    let enter;
    const ready = new Promise((resolve) => (enter = resolve)),
      gate = new Promise((resolve) => (release = resolve));
    s.workspace.editor.probe = async () => {
      enter();
      await gate;
      return 1000;
    };
    s.workspace.editor.metrics(doc.id);
    await ready;
    let closed = false;
    const closing = s.workspace.close().then(() => (closed = true));
    await Promise.resolve();
    assert.equal(closed, false);
    release();
    await closing;
    assert.equal(s.workspace.editor.pendingMetrics.size, 0);
    assert.equal(s.workspace.editor.sessions.size, 0);
  } finally {
    release?.();
    await s.cleanup();
  }
});

test('a closed workspace rejects new editor and transfer work', async () => {
  const s = await setup();
  try {
    const key = s.library.rows[0].key;
    await s.workspace.close();
    await assert.rejects(s.workspace.open(key), /closing/);
    await assert.rejects(s.workspace.prepareAudio([key]), /closing/);
  } finally {
    await s.cleanup();
  }
});
