import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import yazl from 'yazl';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { inspect, prepare, fingerprint, tree, contentKey } from '../app/archive.mjs';
import { trackDocument } from '../app/editor.mjs';
import { sevenZipPath } from '../app/seven-zip.mjs';
import { Device } from '../app/device.mjs';
import { ensureDeviceMarker } from '@studio-pocket/sync-engine/node';
import { checkLibrary } from '@studio-pocket/library-format/node';
const run = promisify(execFile),
  normalizeIcon = (input, output) => sharp(input).resize(16, 16).png().toFile(output);
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-numbered-')),
    folder = path.join(root, 'Henry and Beezus');
  await fs.mkdir(path.join(folder, 'audio_files'), { recursive: true });
  await fs.mkdir(path.join(folder, 'images'));
  for (const n of ['10', '02', '01'])
    await fs.copyFile(
      'vendor/library-format/fixtures/audio/tone-c5.mp3',
      path.join(folder, 'audio_files', n + ' - Chapter ' + Number(n) + '.mp3'),
    );
  for (const [n, color] of [
    ['1', '#ff0000'],
    ['2', '#00ff00'],
    ['10', '#0000ff'],
  ])
    await sharp({ create: { width: 32, height: 32, channels: 3, background: color } })
      .png()
      .toFile(path.join(folder, 'images', n + '.png'));
  await sharp({ create: { width: 270, height: 428, channels: 3, background: '#663399' } })
    .png()
    .toFile(path.join(folder, 'images', 'cover_image.png'));
  await fs.writeFile(
    path.join(folder, 'card.txt'),
    'This is not metadata and must not supply the title.',
  );
  await fs.writeFile(
    path.join(folder, 'tracks.txt'),
    '10 first; 2 second; 1 last — must be ignored.',
  );
  return { root, folder, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
test('audio_files/images convention uses numeric order, numbered icons and cover_image, ignoring both text files', async () => {
  const s = await setup();
  try {
    const before = await fingerprint(s.folder),
      info = await inspect(s.folder);
    assert.equal(info.format, 'numbered');
    assert.equal(info.title, 'Henry and Beezus');
    assert.equal(info.fileCount, 3);
    assert.equal(info.coverName, 'images/cover_image.png');
    assert.ok(info.cover.startsWith('data:image/png'));
    const doc = await trackDocument(s.folder);
    try {
      assert.deepEqual(
        doc.tracks.map((t) => t.iconKey),
        ['images/1.png', 'images/2.png', 'images/10.png'],
      );
      assert.equal(doc.icons.includes('images/cover_image.png'), false);
    } finally {
      await doc.cleanup();
    }
    const p = await prepare(s.folder, { normalizeIcon });
    let key;
    const normalized = p.playlist.tracks[0].iconPath;
    try {
      assert.deepEqual(
        p.playlist.tracks.map((t) => t.entry.title),
        ['Chapter 1', 'Chapter 2', 'Chapter 10'],
      );
      assert.ok(p.playlist.coverPath.endsWith('images/cover_image.png'));
      for (const t of p.playlist.tracks) {
        assert.ok(t.entry.icon);
        assert.equal((await sharp(t.iconPath).metadata()).width, 16);
      }
      key = await contentKey(p.playlist);
      const volume = path.join(s.root, 'Player');
      await fs.mkdir(volume);
      await ensureDeviceMarker(volume, 'tests');
      const device = new Device(volume, async (v) => {
        const st = await fs.lstat(v);
        return { dev: st.dev, ino: st.ino };
      });
      await device.execute({ send: [p.playlist] });
      const result = (await checkLibrary(device.root, { verifyHashes: true })).playlists[0];
      assert.ok(result.ok);
      const base = path.join(device.root, 'playlists', result.id);
      assert.deepEqual(
        await fs.readFile(path.join(base, result.manifest.cover)),
        await fs.readFile(path.join(s.folder, 'images/cover_image.png')),
      );
      const colors = [];
      for (const t of result.manifest.tracks)
        colors.push([...(await sharp(path.join(base, t.icon)).raw().toBuffer()).subarray(0, 3)]);
      assert.deepEqual(colors, [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
      ]);
    } finally {
      await p.cleanup();
    }
    assert.equal(await fs.stat(normalized).catch(() => null), null);
    assert.equal(await fingerprint(s.folder), before);
    assert.equal((await sharp(path.join(s.folder, 'images/1.png')).metadata()).width, 32);
    await fs.writeFile(path.join(s.folder, 'card.txt'), 'Different text, still ignored');
    await fs.writeFile(path.join(s.folder, 'tracks.txt'), 'Not valid JSON, still ignored');
    const unchanged = await prepare(s.folder, { normalizeIcon });
    try {
      assert.equal(await contentKey(unchanged.playlist), key);
    } finally {
      await unchanged.cleanup();
    }
  } finally {
    await s.cleanup();
  }
});
test('the same four-item layout imports from wrapped/rootless 7z and ZIP with matching audio, cover and icons', async () => {
  const s = await setup();
  try {
    const wrapped = path.join(s.root, 'Wrapped.7z');
    await run(sevenZipPath(), ['a', wrapped, path.basename(s.folder)], { cwd: s.root });
    const rootless = path.join(s.root, 'Henry and Beezus.7z');
    await run(sevenZipPath(), ['a', rootless, 'audio_files', 'images', 'card.txt', 'tracks.txt'], {
      cwd: s.folder,
    });
    const zip = path.join(s.root, 'Henry and Beezus.zip'),
      z = new yazl.ZipFile();
    for (const f of await tree(s.folder)) z.addFile(path.join(s.folder, f.name), f.name);
    z.end();
    await pipeline(z.outputStream, createWriteStream(zip));
    let expected;
    for (const source of [s.folder, wrapped, rootless, zip]) {
      const info = await inspect(source);
      assert.equal(info.format, 'numbered');
      assert.equal(info.title, 'Henry and Beezus');
      const p = await prepare(source, { normalizeIcon });
      try {
        const actual = await contentKey(p.playlist);
        if (expected) assert.equal(actual, expected);
        else expected = actual;
      } finally {
        await p.cleanup();
      }
    }
  } finally {
    await s.cleanup();
  }
});
test('numbered Opus audio keeps its numbered icon after conversion', async () => {
  const s = await setup();
  try {
    await fs.rm(path.join(s.folder, 'audio_files'), { recursive: true });
    await fs.mkdir(path.join(s.folder, 'audio_files'));
    await fs.copyFile(
      'test/fixtures/tone-mono.opus',
      path.join(s.folder, 'audio_files', '1 - Opening.opus'),
    );
    const p = await prepare(s.folder, {
      convertOpus: true,
      normalizeIcon,
      encode: async (input, output) => {
        await run('/usr/bin/ffmpeg', [
          '-v',
          'error',
          '-i',
          input,
          '-c:a',
          'aac',
          '-b:a',
          '96000',
          output,
        ]);
      },
    });
    try {
      assert.equal(p.playlist.tracks.length, 1);
      assert.equal(p.playlist.tracks[0].entry.title, 'Opening');
      assert.ok(p.playlist.tracks[0].entry.file.endsWith('.m4a'));
      assert.ok(p.playlist.tracks[0].entry.icon);
      assert.equal((await sharp(p.playlist.tracks[0].iconPath).metadata()).width, 16);
      assert.ok(p.playlist.coverPath);
    } finally {
      await p.cleanup();
    }
  } finally {
    await s.cleanup();
  }
});

test('nested audio_files disc folders keep disc order rather than interleaving repeated track numbers', async () => {
  const s = await setup();
  try {
    await fs.rm(path.join(s.folder, 'audio_files'), { recursive: true });
    for (const dir of ['CD 2', 'CD 1']) {
      await fs.mkdir(path.join(s.folder, 'audio_files', dir), { recursive: true });
      for (const n of ['2', '1'])
        await fs.copyFile(
          'vendor/library-format/fixtures/audio/tone-c5.mp3',
          path.join(s.folder, 'audio_files', dir, n + '.mp3'),
        );
    }
    const info = await inspect(s.folder);
    assert.equal(info.format, 'folder');
    assert.equal(info.coverName, 'images/cover_image.png');
    const p = await prepare(s.folder);
    try {
      assert.deepEqual(
        p.playlist.tracks.map((t) => path.relative(s.folder, t.localPath)),
        [
          'audio_files/CD 1/1.mp3',
          'audio_files/CD 1/2.mp3',
          'audio_files/CD 2/1.mp3',
          'audio_files/CD 2/2.mp3',
        ],
      );
    } finally {
      await p.cleanup();
    }
  } finally {
    await s.cleanup();
  }
});
test('solid 7z details batch picture requests into one extraction and defer audio', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-solid-pictures-'));
  try {
    const source = path.join(root, 'Story');
    await fs.mkdir(path.join(source, 'audio_files'), { recursive: true });
    await fs.mkdir(path.join(source, 'images'));
    for (const n of [1, 2]) {
      await fs.copyFile(
        'vendor/library-format/fixtures/audio/tone-c5.mp3',
        path.join(source, 'audio_files', n + '.mp3'),
      );
      await sharp({
        create: { width: 16, height: 16, channels: 3, background: n === 1 ? '#ff0000' : '#0000ff' },
      })
        .png()
        .toFile(path.join(source, 'images', n + '.png'));
    }
    const archive = path.join(root, 'Story.7z');
    await run(sevenZipPath(), ['a', '-t7z', '-ms=on', '-mx=1', archive, '.'], { cwd: source });
    const before = await fingerprint(archive),
      { quickDocument } = await import('../app/editor.mjs'),
      doc = await quickDocument(archive);
    let files;
    try {
      const statfs = fs.statfs;
      fs.statfs = async () => ({ bavail: 256 * 1024 ** 2 + 512, bsize: 1 });
      try {
        files = await Promise.all(doc.icons.map((key) => doc.file(key)));
      } finally {
        fs.statfs = statfs;
      }
      assert.equal(files.length, 2);
      assert.equal(path.dirname(files[0]), path.dirname(files[1]));
      assert.equal(
        await fs
          .stat(path.join(path.dirname(files[0]), '..', 'audio_files', '1.mp3'))
          .catch(() => null),
        null,
      );
      assert.equal(await fingerprint(archive), before);
    } finally {
      await doc.cleanup();
    }
    for (const file of files) assert.equal(await fs.stat(file).catch(() => null), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
