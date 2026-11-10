import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import sharp from 'sharp';
import { inspect, prepare, fingerprint, tree, safeName, contentKey } from '../app/archive.mjs';
import { Device } from '../app/device.mjs';
import { Library, friendly } from '../app/library.mjs';
import { ensureDeviceMarker } from '@studio-pocket/sync-engine/node';
import { checkLibrary } from '@studio-pocket/library-format/node';
const fixture = path.resolve('vendor/library-format/fixtures/audio');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-drop-tests-'));
const cover = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#557799' } })
  .png()
  .toBuffer();
const icon = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#8866cc' } })
  .png()
  .toBuffer();
const dir = async (name) => {
  const p = path.join(root, name);
  await fs.mkdir(p, { recursive: true });
  return p;
};
async function website(name = 'Story #1', folder = name) {
  const p = await dir(folder);
  await fs.mkdir(path.join(p, 'audio'));
  await fs.mkdir(path.join(p, 'icons'));
  await fs.copyFile(path.join(fixture, 'tone-c5.mp3'), path.join(p, 'audio', '00-First.mp3'));
  await fs.copyFile(path.join(fixture, 'tone-g5.mp3'), path.join(p, 'audio', '01-Second.mp3'));
  await fs.writeFile(path.join(p, 'cover.png'), cover);
  await fs.writeFile(path.join(p, 'icons', '00.png'), icon);
  await fs.writeFile(
    path.join(p, 'metadata.json'),
    JSON.stringify({
      format: 'myo-studio-archive',
      title: name,
      cover: 'cover.png',
      tracks: [
        { index: 1, title: 'Second chapter', audio: 'audio/01-Second.mp3' },
        { index: 0, title: 'First chapter', audio: 'audio/00-First.mp3', icon: 'icons/00.png' },
      ],
    }),
  );
  return p;
}
async function chrome() {
  const p = await dir('Chrome Café #2');
  await fs.mkdir(path.join(p, 'audio'));
  await fs.mkdir(path.join(p, 'icons'));
  await fs.mkdir(path.join(p, 'cover'));
  await fs.mkdir(path.join(p, 'data'));
  await fs.writeFile(
    path.join(p, 'data', 'metadata.json'),
    JSON.stringify({ title: 'Chrome download information' }),
  );
  await fs.writeFile(path.join(p, 'data', 'card-data.json'), '{}');
  await fs.writeFile(path.join(p, 'data', 'resolved-card-data.json'), '{}');
  await fs.copyFile(path.join(fixture, 'tone-c5.mp3'), path.join(p, 'audio', '00-First.mp3'));
  await fs.copyFile(path.join(fixture, 'tone-g5.mp3'), path.join(p, 'audio', '01-Second.mp3'));
  await fs.writeFile(path.join(p, 'icons', '00-First-icon.png'), icon);
  await fs.writeFile(path.join(p, 'cover', 'cover.png'), cover);
  await fs.writeFile(
    path.join(p, 'data', 'simplified-card-data.json'),
    JSON.stringify({
      title: 'Chrome Café #2',
      chapters: [
        { key: '00', title: 'First chapter' },
        { key: '01', title: 'Second chapter' },
      ],
      url: 'https://private.example/?token=secret',
    }),
  );
  return p;
}
async function zip(folder, filename, wrapped = true) {
  const z = new yazl.ZipFile();
  for (const f of await tree(folder))
    z.addFile(path.join(folder, f.name), (wrapped ? path.basename(folder) + '/' : '') + f.name);
  z.end();
  const p = path.join(root, filename);
  await pipeline(z.outputStream, createWriteStream(p));
  return p;
}
let web, chr, webZip, chrZip;
test('archive formats, cover-only ZIP inspection, chapter order, supported icons, untouched originals', async () => {
  web = await website();
  chr = await chrome();
  webZip = await zip(web, 'website.zip');
  chrZip = await zip(chr, "Chrome's #2.zip");
  for (const [source, format] of [
    [web, 'website'],
    [webZip, 'website'],
    [chr, 'chrome'],
    [chrZip, 'chrome'],
    [await zip(chr, 'Chrome-rootless.zip', false), 'chrome'],
  ]) {
    const before = await fingerprint(source);
    const info = await inspect(source);
    assert.equal(info.format, format);
    assert.ok(info.cover.startsWith('data:image/png;base64,'));
    const p = await prepare(source);
    assert.deepEqual(
      p.playlist.manifest.tracks.map((t) => t.title),
      ['First chapter', 'Second chapter'],
    );
    assert.ok(p.playlist.tracks[0].iconPath);
    assert.ok(p.playlist.manifest.tracks[0].icon);
    await p.cleanup();
    assert.equal(await fingerprint(source), before);
  }
  assert.equal(await fs.stat(path.join(chr, 'metadata.json')).catch(() => null), null);
});
test('unsafe ZIP paths, corrupt ZIPs, links, oversized metadata and unsupported audio are refused', async () => {
  for (const p of ['../escape', '/absolute', 'C:/evil', 'safe/../escape', 'x\\evil'])
    assert.throws(() => safeName(p));
  const corrupt = path.join(root, 'bad.zip');
  await fs.writeFile(corrupt, 'broken');
  await assert.rejects(inspect(corrupt));
  const malicious = new yazl.ZipFile();
  malicious.addBuffer(Buffer.from('bad'), 'aa/escape');
  malicious.end();
  const chunks = [];
  for await (const b of malicious.outputStream) chunks.push(b);
  const b = Buffer.concat(chunks);
  for (let pos = 0; (pos = b.indexOf(Buffer.from('aa/escape'), pos)) >= 0; pos += 9)
    b.write('../escape', pos);
  const attack = path.join(root, 'attack.zip');
  await fs.writeFile(attack, b);
  await assert.rejects(inspect(attack));
  const link = await dir('links');
  await fs.symlink('/etc/passwd', path.join(link, 'outside'));
  await assert.rejects(inspect(link), /Symbolic/);
  const badAudio = await website('Bad audio');
  await fs.writeFile(path.join(badAudio, 'audio', '00-First.mp3'), 'not audio');
  await assert.rejects(prepare(badAudio), /cannot read/);
  const unsupported = await website('Unsupported');
  await fs.rename(
    path.join(unsupported, 'audio', '00-First.mp3'),
    path.join(unsupported, 'audio', '00-First.opus'),
  );
  let meta = JSON.parse(await fs.readFile(path.join(unsupported, 'metadata.json')));
  meta.tracks[1].audio = 'audio/00-First.opus';
  await fs.writeFile(path.join(unsupported, 'metadata.json'), JSON.stringify(meta));
  await assert.rejects(prepare(unsupported), /Opus/);
});
test('plain MP3 folder and rootless ZIP have stable identities', async () => {
  const p = await dir('Ordinary story');
  await fs.copyFile(path.join(fixture, 'tone-c5.mp3'), path.join(p, 'Chapter 01.mp3'));
  await fs.writeFile(path.join(p, 'cover.png'), cover);
  const zipped = await zip(p, 'Ordinary story.zip', false);
  const a = await prepare(p),
    b = await prepare(zipped);
  assert.equal(a.playlist.manifest.id, b.playlist.manifest.id);
  assert.ok(a.playlist.coverPath);
  await a.cleanup();
  await b.cleanup();
});
const simulated = async () => {
  const volume = await dir('Y2-' + Math.random());
  await ensureDeviceMarker(volume, 'Pocket Drop simulated tests');
  return new Device(volume, async (p) => {
    const s = await fs.lstat(p);
    return { dev: s.dev, ino: s.ino };
  });
};
test('real engine sync, no-op, artwork changes, removal, index and state cleanup, originals and unrelated content preserved, resync', async () => {
  const device = await simulated();
  const a = await prepare(web),
    b = await prepare(chr);
  const original = await fingerprint(web);
  try {
    let result = await device.execute({ send: [a.playlist, b.playlist] });
    assert.equal(result.written.length, 2);
    assert.equal((await checkLibrary(device.root)).playlists.length, 2);
    let plan = await device.plan([a.playlist]);
    assert.equal(plan.bytesToCopy, 0);
    assert.equal(plan.playlists.find((p) => p.id === a.playlist.manifest.id).kind, 'keep');
    result = await device.execute({ send: [a.playlist] });
    assert.equal(result.written.length, 0);
    const coverPath = path.join(device.root, 'playlists', a.playlist.manifest.id, 'cover.png');
    const altered = await fs.readFile(coverPath);
    altered[altered.length - 10] ^= 1;
    await fs.writeFile(coverPath, altered);
    plan = await device.plan([a.playlist]);
    assert.equal(plan.playlists.find((p) => p.id === a.playlist.manifest.id).kind, 'update');
    assert.ok(plan.bytesToCopy > 0);
    await device.execute({ send: [a.playlist] });
    await fs.mkdir(path.join(device.root, 'state'), { recursive: true });
    await fs.writeFile(path.join(device.root, 'state', a.playlist.manifest.id + '.json'), 'state');
    const removalProgress = [];
    result = await device.execute({
      remove: [a.playlist.manifest.id],
      onProgress: (e) => {
        if (e.phase === 'remove') removalProgress.push(e.percent);
      },
    });
    assert.equal(removalProgress[0], 0);
    assert.equal(removalProgress.at(-1), 100);
    assert.ok(removalProgress.some((n) => n > 0 && n < 100));
    assert.ok(removalProgress.every((n, i) => !i || n >= removalProgress[i - 1]));
    assert.deepEqual(result.removed, [a.playlist.manifest.id]);
    assert.equal(
      await fs
        .stat(path.join(device.root, 'state', a.playlist.manifest.id + '.json'))
        .catch(() => null),
      null,
    );
    let check = await checkLibrary(device.root);
    assert.deepEqual(
      check.playlists.map((p) => p.id),
      [b.playlist.manifest.id],
    );
    assert.ok(check.playlists[0].ok);
    assert.equal(await fingerprint(web), original);
    plan = await device.plan([a.playlist]);
    assert.equal(plan.playlists.find((p) => p.id === a.playlist.manifest.id).kind, 'add');
    await device.execute({ send: [a.playlist] });
    check = await checkLibrary(device.root);
    assert.equal(check.playlists.length, 2);
    assert.ok(check.playlists.every((p) => p.ok));
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});
test('same-size changed audio is detected and unrelated playlists are untouched', async () => {
  const device = await simulated();
  const a = await prepare(web);
  await device.execute({ send: [a.playlist] });
  const track = path.join(
    device.root,
    'playlists',
    a.playlist.manifest.id,
    a.playlist.tracks[0].entry.file,
  );
  const b = await fs.readFile(track);
  b[b.length - 1] ^= 1;
  await fs.writeFile(track, b);
  const plan = await device.plan([a.playlist]);
  assert.ok(plan.bytesToCopy > 0);
  await device.execute({ send: [a.playlist] });
  assert.ok((await checkLibrary(device.root, { verifyHashes: true })).playlists[0].ok);
  await a.cleanup();
});
test('path traversal removal and changed device identity are refused without writes', async () => {
  const device = await simulated();
  const p = await prepare(web);
  await device.execute({ send: [p.playlist] });
  const before = await fingerprint(device.volume);
  await assert.rejects(device.execute({ remove: ['../anything'] }), /Invalid playlist/);
  await assert.rejects(
    device.execute({ remove: [p.playlist.manifest.id], expectedDeviceId: 'wrong-player' }),
    /player changed/,
  );
  assert.equal(await fingerprint(device.volume), before);
  await p.cleanup();
});
test('device-side symlinks are refused before operations', async () => {
  const device = await simulated();
  const out = await dir('outside-device');
  await fs.symlink(out, path.join(device.root, 'playlists'));
  await assert.rejects(device.execute({ remove: ['story'] }), /Symbolic/);
  assert.deepEqual(await fs.readdir(out), []);
});
test('disconnect mid-copy is reported, no success assumed, re-sync recovers', async () => {
  const device = await simulated();
  const p = await prepare(web);
  let disconnected = false;
  await assert.rejects(
    device.execute({
      send: [p.playlist],
      onProgress: () => {
        if (!disconnected) {
          disconnected = true;
          return fs.rename(
            path.join(device.root, 'device.json'),
            path.join(device.root, 'device.json.unplugged'),
          );
        }
      },
    }),
  );
  await fs.rename(
    path.join(device.root, 'device.json.unplugged'),
    path.join(device.root, 'device.json'),
  );
  await device.execute({ send: [p.playlist] });
  assert.ok((await checkLibrary(device.root, { verifyHashes: true })).playlists[0].ok);
  await p.cleanup();
});
test('out-of-space errors are translated into a helpful message', () =>
  assert.equal(
    friendly(new Error('need 123 bytes plus 44 reserve, volume has 0 free')),
    'Not enough space on MYO Pocket. Remove some audio or select fewer files.',
  ));
test('library discovers/removes files, merges equivalent editions, detects device-only books, retains Inbox after removal', async () => {
  const inbox = await dir('Inbox');
  const local = path.join(inbox, 'Story #1');
  await fs.cp(web, local, { recursive: true });
  await fs.copyFile(webZip, path.join(inbox, 'Renamed #1.zip'));
  const old = new Date(Date.now() - 10000);
  await fs.utimes(local, old, old);
  await fs.utimes(path.join(inbox, 'Renamed #1.zip'), old, old);
  const device = await simulated();
  const b = await prepare(chr);
  await device.execute({ send: [b.playlist] });
  await b.cleanup();
  const lib = new Library({ inbox, device });
  await lib.scan();
  assert.equal(lib.rows.filter((r) => r.local).length, 2);
  assert.ok(lib.rows.filter((r) => r.local).every((r) => r.unverified));
  assert.equal(lib.rows.filter((r) => !r.local).length, 1);
  await assert.rejects(
    lib.transfer(
      lib.rows.filter((r) => r.local).map((r) => r.key),
      'sync',
    ),
    /one local edition/,
  );
  const localRow = lib.rows.find((r) => r.local);
  assert.equal(localRow.status, 'ready');
  let plans = 0;
  const originalPlan = device.plan.bind(device);
  device.plan = (...args) => {
    plans++;
    return originalPlan(...args);
  };
  await lib.transfer([localRow.key], 'sync');
  assert.equal(lib.busy, false);
  assert.equal(lib.scanning, false);
  assert.equal(lib.lastResult.counts.added, 1);
  assert.ok(lib.rows.find((r) => r.key === localRow.key).preparedBytes > 0);
  assert.equal(plans, 0, 'verified sync must not re-plan and rehash the library');
  let locked = false;
  lib.on('change', (s) => {
    if (s.scanning) locked = true;
  });
  await lib.scan();
  assert.equal(locked, false, 'unchanged background poll must not lock controls');
  assert.equal(lib.rows.find((r) => r.key === localRow.key).status, 'current');
  const other = lib.rows.find((r) => r.local && r.key !== localRow.key);
  await lib.transfer([other.key], 'sync');
  assert.equal(lib.rows.filter((r) => r.local).length, 1);
  assert.equal(lib.rows.find((r) => r.local).duplicates, 2);
  await lib.transfer([localRow.key], 'remove', lib.deviceState.deviceId);
  assert.equal(lib.rows.find((r) => r.local).status, 'ready');
  assert.ok(await fs.stat(local));
  assert.ok(await fs.stat(path.join(inbox, 'Renamed #1.zip')));
  await fs.rm(local, { recursive: true });
  await fs.rm(path.join(inbox, 'Renamed #1.zip'));
  await lib.scan();
  assert.equal(lib.rows.filter((r) => r.local).length, 0);
});
test('disconnected local library remains visible; conflicting editions are blocked', async () => {
  const inbox = await dir('Offline Inbox');
  await fs.cp(web, path.join(inbox, 'First'), { recursive: true });
  await fs.cp(web, path.join(inbox, 'Different edition'), { recursive: true });
  const metaPath = path.join(inbox, 'Different edition', 'metadata.json');
  const meta = JSON.parse(await fs.readFile(metaPath));
  meta.tracks[0].title = 'Different title';
  await fs.writeFile(metaPath, JSON.stringify(meta));
  const old = new Date(Date.now() - 10000);
  await fs.utimes(path.join(inbox, 'First'), old, old);
  await fs.utimes(path.join(inbox, 'Different edition'), old, old);
  const lib = new Library({ inbox, device: { inspect: async () => ({ connected: false }) } });
  await lib.scan();
  assert.equal(lib.rows.length, 2);
  assert.ok(
    lib.rows.every((r) => r.status === 'disconnected' && r.message.includes('Possible duplicate')),
  );
  await fs.rm(path.join(inbox, 'Different edition'), { recursive: true });
  await lib.scan();
  assert.equal(lib.rows[0].status, 'disconnected');
});
test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
test('ZIP CRC damage and unsafe native metadata are refused; extra audio is preserved', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-extra-'));
  try {
    const z = new yazl.ZipFile();
    const meta = JSON.stringify({
      format: 'myo-studio-archive',
      title: 'Check',
      tracks: [{ index: 0, title: 'First', audio: 'audio/a.mp3' }],
    });
    z.addBuffer(Buffer.from(meta), 'metadata.json', { compress: false });
    z.addBuffer(Buffer.from('audio'), 'audio/a.mp3', { compress: false });
    z.end();
    const chunks = [];
    for await (const b of z.outputStream) chunks.push(b);
    const data = Buffer.concat(chunks);
    const at = data.indexOf(Buffer.from('Check'));
    assert.ok(at > 0);
    data[at] ^= 1;
    const bad = path.join(dir, 'CRC.zip');
    await fs.writeFile(bad, data);
    await assert.rejects(inspect(bad), /checksum/);
    const unsafe = path.join(dir, 'unsafe');
    await fs.mkdir(path.join(unsafe, 'audio'), { recursive: true });
    await fs.copyFile(path.join(fixture, 'tone-c5.mp3'), path.join(unsafe, 'audio', 'a.mp3'));
    await fs.writeFile(
      path.join(unsafe, 'metadata.json'),
      JSON.stringify({
        format: 'myo-studio-archive',
        title: 'Unsafe',
        tracks: [{ index: 0, title: 'First', audio: '../outside.mp3' }],
      }),
    );
    await assert.rejects(prepare(unsafe), /Unsafe/);
    const extra = JSON.stringify({
      format: 'myo-studio-archive',
      title: 'Extra',
      tracks: [{ index: 0, title: 'First', audio: 'audio/a.mp3' }],
    });
    await fs.writeFile(path.join(unsafe, 'metadata.json'), extra);
    await fs.copyFile(path.join(fixture, 'tone-g5.mp3'), path.join(unsafe, 'audio', 'extra.mp3'));
    const complete = await prepare(unsafe);
    try {
      assert.equal(complete.playlist.tracks.length, 2);
    } finally {
      await complete.cleanup();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
