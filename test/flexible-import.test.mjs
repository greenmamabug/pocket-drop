import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspect, prepare, fingerprint } from '../app/archive.mjs';
import { sevenZipPath } from '../app/seven-zip.mjs';
import { importAudio } from '../app/import-audio.mjs';
import { Library } from '../app/library.mjs';
import { Device } from '../app/device.mjs';
import { ensureDeviceMarker } from '@studio-pocket/sync-engine/node';
import { checkLibrary } from '@studio-pocket/library-format/node';
const exec = promisify(execFile);
const sample = path.resolve('vendor/library-format/fixtures/audio/tone-c5.mp3');
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-flex-'));
  const folder = path.join(root, 'Henry and Beezus');
  await fs.mkdir(folder);
  return { root, folder, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
async function audio(folder, name) {
  const target = path.join(folder, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(sample, target);
  return target;
}
function id3(tags) {
  const frames = Object.entries(tags).map(([key, value]) => {
    const data = Buffer.from('\0' + value, 'latin1'),
      head = Buffer.alloc(10);
    head.write(key);
    head.writeUInt32BE(data.length, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(frames),
    head = Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 4; i++) head[9 - i] = (body.length >>> (7 * i)) & 127;
  return Buffer.concat([head, body]);
}
test('nested audio with no card details uses natural disc and file order and syncs every file', async () => {
  const s = await setup();
  try {
    for (const n of [
      'CD 10/1 - Last.mp3',
      'CD 2/10 - Ten.mp3',
      'CD 2/2 - Two.mp3',
      'CD 1/1 - Start.mp3',
    ])
      await audio(s.folder, n);
    await fs.writeFile(path.join(s.folder, 'readme.txt'), 'not audio');
    const before = await fingerprint(s.folder),
      info = await inspect(s.folder);
    assert.equal(info.title, 'Henry and Beezus');
    assert.equal(info.fileCount, 4);
    const prepared = await prepare(s.folder);
    try {
      assert.deepEqual(
        prepared.playlist.tracks.map((t) => t.entry.title),
        ['1 - Start', '2 - Two', '10 - Ten', '1 - Last'],
      );
      const volume = path.join(s.root, 'Player');
      await fs.mkdir(volume);
      await ensureDeviceMarker(volume, 'tests');
      const device = new Device(volume, async (p) => {
        const st = await fs.stat(p);
        return { dev: st.dev, ino: st.ino };
      });
      await device.execute({ send: [prepared.playlist] });
      const library = await checkLibrary(device.root, { verifyHashes: true });
      assert.equal(library.playlists[0].manifest.tracks.length, 4);
      assert.ok(library.playlists[0].ok);
    } finally {
      await prepared.cleanup();
    }
    assert.equal(await fingerprint(s.folder), before);
  } finally {
    await s.cleanup();
  }
});
test('missing, unrelated, malformed and incomplete metadata fall back without omitting audio', async () => {
  const s = await setup();
  try {
    await audio(s.folder, 'odd/place/2.mp3');
    await audio(s.folder, 'elsewhere/1.mp3');
    for (const data of [
      '{broken',
      '{}',
      JSON.stringify({ title: 'Henry', tracks: [] }),
      JSON.stringify({
        format: 'myo-studio-archive',
        title: 'Henry',
        tracks: [{ index: 0, title: 'Only one', audio: 'missing.mp3' }],
      }),
    ]) {
      await fs.writeFile(path.join(s.folder, 'metadata.json'), data);
      const p = await prepare(s.folder);
      try {
        assert.equal(p.playlist.tracks.length, 2);
      } finally {
        await p.cleanup();
      }
    }
  } finally {
    await s.cleanup();
  }
});
test('complete embedded track tags override alphabetical names; duplicate or partial tags fall back', async () => {
  const s = await setup();
  try {
    const first = await audio(s.folder, 'Zebra.mp3'),
      second = await audio(s.folder, 'Apple.mp3');
    const original = await fs.readFile(sample);
    await fs.writeFile(
      first,
      Buffer.concat([id3({ TIT2: 'Opening', TRCK: '1', TPOS: '1' }), original]),
    );
    await fs.writeFile(
      second,
      Buffer.concat([id3({ TIT2: 'Closing', TRCK: '2', TPOS: '1' }), original]),
    );
    let p = await prepare(s.folder);
    assert.deepEqual(
      p.playlist.tracks.map((t) => t.entry.title),
      ['Opening', 'Closing'],
    );
    await p.cleanup();
    await fs.writeFile(
      second,
      Buffer.concat([id3({ TIT2: 'Closing', TRCK: '1', TPOS: '1' }), original]),
    );
    p = await prepare(s.folder);
    assert.deepEqual(
      p.playlist.tracks.map((t) => t.entry.title),
      ['Closing', 'Opening'],
    );
    await p.cleanup();
    await fs.writeFile(second, original);
    p = await prepare(s.folder);
    assert.equal(p.playlist.tracks[0].entry.title, 'Apple');
    await p.cleanup();
  } finally {
    await s.cleanup();
  }
});
test('7z imports copy originals and refresh offline; archive and extracted folder have matching identities', async () => {
  const s = await setup();
  try {
    await audio(s.folder, 'CD 1/2.mp3');
    await audio(s.folder, 'CD 1/10.mp3');
    const archive = path.join(s.root, 'Henry.7z');
    await exec(sevenZipPath(), ['a', archive, path.basename(s.folder)], { cwd: s.root });
    const before = await fingerprint(archive),
      info = await inspect(archive);
    assert.equal(info.fileCount, 2);
    assert.equal(info.title, 'Henry and Beezus');
    const a = await prepare(archive),
      b = await prepare(s.folder);
    try {
      assert.deepEqual(a.playlist.manifest, b.playlist.manifest);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
    assert.equal(await fingerprint(archive), before);
    const inbox = path.join(s.root, 'Inbox');
    assert.equal((await importAudio([archive], inbox)).imported, 1);
    const old = new Date(Date.now() - 10000);
    await fs.utimes(path.join(inbox, 'Henry.7z'), old, old);
    const library = new Library({ inbox, device: { inspect: async () => ({ connected: false }) } });
    await library.scan(true);
    assert.equal(library.rows.length, 1);
    assert.equal(library.rows[0].tracks, 2);
    assert.equal(library.rows[0].status, 'disconnected');
    await audio(inbox, 'New book/deep/01.mp3');
    await fs.utimes(path.join(inbox, 'New book'), old, old);
    await library.scan(true);
    assert.equal(library.rows.length, 2);
    assert.ok(library.rows.every((r) => r.status === 'disconnected'));
  } finally {
    await s.cleanup();
  }
});
test('7z links, encryption and corrupt data are refused', async () => {
  const s = await setup();
  try {
    await audio(s.folder, '01.mp3');
    await fs.symlink('/etc/passwd', path.join(s.folder, 'outside'));
    const linked = path.join(s.root, 'linked.7z');
    await exec(sevenZipPath(), ['a', '-snl', linked, path.basename(s.folder)], { cwd: s.root });
    await assert.rejects(inspect(linked), /link|special/);
    await fs.rm(path.join(s.folder, 'outside'));
    const encrypted = path.join(s.root, 'encrypted.7z');
    await exec(sevenZipPath(), ['a', '-psecret', encrypted, path.basename(s.folder)], {
      cwd: s.root,
    });
    await assert.rejects(inspect(encrypted), /Encrypted/);
    const broken = path.join(s.root, 'broken.7z');
    await fs.writeFile(broken, 'not a 7z');
    await assert.rejects(inspect(broken), /Cannot read/);
  } finally {
    await s.cleanup();
  }
});
