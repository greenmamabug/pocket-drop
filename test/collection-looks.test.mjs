// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { validateGroups } from '@studio-pocket/library-format';
import { ensureDeviceMarker } from '@studio-pocket/sync-engine/node';
import { Device } from '../app/device.mjs';
import { Catalog } from '../app/catalog.mjs';
import {
  collectionPreview,
  collectionCoverLabels,
  collectionStackSides,
  withCollectionMembers,
} from '../app/collection-model.mjs';
import { collectionRevision, collectionsPending } from '../app/collection-state.mjs';
const group = {
  id: 'bedtime',
  title: 'Bedtime',
  icon: null,
  playlists: ['one', 'two', 'three', 'four'],
};
const file = (groups) => ({
  format: 'studiopocket-groups',
  formatVersion: 1,
  updatedAt: 'test',
  generator: 'test',
  groups,
});
const rows = ['one', 'two', 'three', 'four'].map((id) => ({
  id,
  title: id,
  cover: id + '.png',
  local: true,
}));
const picture = {
  thumbnail: 'circle.png',
  cardThumbnail: 'portrait.png',
  ref: 'circle',
  iconRef: 'icon',
  imageRef: 'portrait',
};
async function setup(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-collection-look-'));
  try {
    const volume = path.join(root, 'Player');
    await fs.mkdir(volume);
    await ensureDeviceMarker(volume, 'tests');
    const device = new Device(volume, async (p) => {
      const st = await fs.stat(p);
      return { dev: st.dev, ino: st.ino };
    });
    await fn({ root, device, catalog: await new Catalog(path.join(root, 'Catalog')).load() });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
test('new collection format preserves display/image/cover order and legacy defaults', () => {
  const parsed = validateGroups(
    file([{ ...group, display: 'covers', image: 'groups/portrait.png', covers: ['three', 'one'] }]),
  ).groups[0];
  assert.equal(parsed.display, 'covers');
  assert.equal(parsed.image, 'groups/portrait.png');
  assert.deepEqual(parsed.covers, ['three', 'one']);
  assert.equal(validateGroups(file([group])).groups[0].display, undefined);
  for (const fields of [
    { covers: ['one', 'two', 'three', 'four'] },
    { covers: ['one', 'one'] },
    { covers: ['other'] },
    { image: '../outside.png' },
  ])
    assert.throws(() => validateGroups(file([{ ...group, ...fields }])));
});
test('collection previews match player icon, picture, chosen and recent fallback/stack rules', () => {
  assert.equal(collectionPreview(group, rows, picture)[0].kind, 'icon');
  assert.equal(
    collectionPreview({ ...group, display: 'image', image: 'groups/x.png' }, rows, picture)[0].src,
    'portrait.png',
  );
  assert.equal(collectionPreview({ ...group, display: 'image' }, rows, null)[0].kind, 'icon');
  const chosen = collectionPreview(
    { ...group, display: 'covers', image: 'groups/x.png', covers: ['three', 'one', 'four'] },
    rows,
    picture,
  );
  assert.deepEqual(
    chosen.map((c) => c.src),
    ['portrait.png', 'three.png', 'one.png'],
  );
  const recent = collectionPreview({ ...group, display: 'recent' }, rows, null, [
    'gone',
    'three',
    'one',
  ]);
  assert.deepEqual(
    recent.map((c) => c.src),
    ['three.png', 'one.png', 'two.png'],
  );
  assert.equal(
    collectionPreview(
      { ...group, display: 'covers', covers: ['one'] },
      [{ ...rows[0], hidden: true }],
      null,
    )[0].kind,
    'icon',
  );
  assert.equal(
    collectionPreview({ ...group, display: 'image', image: 'groups/x.png' }, rows, {
      thumbnail: 'legacy-square.png',
    })[0].src,
    'legacy-square.png',
  );
});
test('moving collection members drops their cover choices without mutating saved input', () => {
  const original = { ...group, display: 'covers', covers: ['three', 'one'] };
  const changed = withCollectionMembers(original, ['one', 'four']);
  assert.deepEqual(changed.covers, ['one']);
  assert.deepEqual(original.covers, ['three', 'one']);
  assert.equal(validateGroups(file([changed])).groups[0].display, 'covers');
});
test('cover positions follow player cardinality, including a picture and missing artwork', () => {
  assert.deepEqual(collectionStackSides(1), ['front']);
  assert.deepEqual(collectionStackSides(2), ['front', 'right']);
  assert.deepEqual(collectionStackSides(3), ['front', 'left', 'right']);
  const two = { ...group, display: 'covers', covers: ['one', 'two'] };
  assert.deepEqual(collectionCoverLabels(two, rows, null), [
    'First cover (front)',
    'Second cover (right)',
    'Third cover (right when added)',
  ]);
  assert.deepEqual(collectionCoverLabels({ ...two, covers: ['one', 'two', 'three'] }, rows, null), [
    'First cover (front)',
    'Second cover (left)',
    'Third cover (right)',
  ]);
  assert.deepEqual(collectionCoverLabels({ ...two, image: 'groups/picture.png' }, rows, picture), [
    'Second cover (left)',
    'Third cover (right)',
    'Extra cover (not shown with picture)',
  ]);
  assert.deepEqual(
    collectionCoverLabels(
      { ...two, covers: ['one'], image: 'groups/picture.png' },
      rows,
      picture,
    ).slice(0, 1),
    ['Second cover (right)'],
  );
  const missing = rows.map((row) => (row.id === 'one' ? { ...row, cover: null } : row));
  assert.deepEqual(collectionCoverLabels(two, missing, null).slice(0, 2), [
    'First cover (artwork unavailable)',
    'Second cover (front)',
  ]);
});
test('pending detection includes appearance/image changes and preserves player-owned recent order', () => {
  const data = {
    groups: [{ ...group, display: 'covers', covers: ['one', 'two'] }],
    collectionPictures: { bedtime: picture },
  };
  const device = {
    connected: true,
    initialized: true,
    deviceId: 'player',
    check: { groups: file(structuredClone(data.groups)) },
  };
  data.collectionsSynced = { player: collectionRevision(data) };
  assert.equal(collectionsPending(device, data), false);
  device.check.recent = { playlists: ['two'] };
  assert.equal(collectionsPending(device, data), false);
  for (const patch of [
    { display: 'recent' },
    { covers: ['two', 'one'] },
    { image: 'groups/picture.png' },
  ])
    assert.equal(
      collectionsPending(device, { ...data, groups: [{ ...data.groups[0], ...patch }] }),
      true,
    );
  assert.equal(
    collectionsPending(device, {
      ...data,
      collectionPictures: { bedtime: { ...picture, imageRef: 'new-image' } },
    }),
    true,
  );
});
test('looks survive catalog reload/device copy with portrait artwork and preserved listening history', () =>
  setup(async ({ root, device, catalog }) => {
    const recent = {
      format: 'studiopocket-recent',
      formatVersion: 1,
      updatedAt: 'test',
      playlists: ['two', 'one'],
    };
    const history = path.join(device.root, 'recent.json');
    await fs.writeFile(history, JSON.stringify(recent));
    const source = path.join(root, 'picture.png');
    await sharp({ create: { width: 252, height: 400, channels: 3, background: '#8844aa' } })
      .png()
      .toFile(source);
    const ours = {
      ...group,
      display: 'covers',
      image: 'groups/bedtime-image-1.png',
      icon: 'groups/bedtime-1.png',
      covers: ['three', 'one'],
    };
    await catalog.groups([ours]);
    assert.deepEqual((await new Catalog(catalog.folder).load()).data.groups[0], ours);
    await device.saveGroups([
      {
        id: 'other',
        title: 'Other',
        icon: null,
        playlists: ['one', 'extra'],
        display: 'covers',
        covers: ['one', 'extra'],
      },
    ]);
    await device.saveGroups([ours], {
      ownedIds: ['bedtime'],
      icons: new Map([
        [ours.image, source],
        [ours.icon, source],
      ]),
    });
    const saved = JSON.parse(await fs.readFile(path.join(device.root, 'groups.json')));
    assert.deepEqual(
      saved.groups.find((g) => g.id === 'bedtime'),
      ours,
    );
    assert.deepEqual(saved.groups[0].covers, ['extra']);
    assert.deepEqual(await device.collectionArtwork(ours.image), await fs.readFile(source));
    assert.equal((await sharp(path.join(device.root, ours.image)).metadata()).height, 400);
    assert.equal((await device.inspect()).check.recent.playlists[0], 'two');
    assert.equal(await fs.readFile(history, 'utf8'), JSON.stringify(recent));
  }));
test('collection artwork reads reject outside paths, links and oversized files', () =>
  setup(async ({ root, device }) => {
    await fs.mkdir(path.join(device.root, 'groups'));
    const outside = path.join(root, 'outside.png');
    await fs.writeFile(outside, 'private');
    await assert.rejects(device.collectionArtwork('../outside.png'), /Invalid/);
    await fs.symlink(outside, path.join(device.root, 'groups', 'linked.png'));
    await assert.rejects(device.collectionArtwork('groups/linked.png'), /link|Unsafe/);
    await fs.rm(path.join(device.root, 'groups', 'linked.png'));
    await fs.writeFile(
      path.join(device.root, 'groups', 'big.png'),
      Buffer.alloc(4 * 1024 ** 2 + 1),
    );
    await assert.rejects(device.collectionArtwork('groups/big.png'), /too large/);
  }));
test('artwork readback failure preserves previous group metadata and releases its lock', () =>
  setup(async ({ root, device }) => {
    await device.saveGroups([group]);
    const metadata = path.join(device.root, 'groups.json'),
      before = await fs.readFile(metadata, 'utf8');
    const source = path.join(root, 'new.png');
    await fs.writeFile(source, 'new image');
    const target = path.join(device.root, 'groups', 'new-image.png'),
      read = fs.readFile;
    fs.readFile = async (file, ...args) =>
      String(file) === target ? Buffer.from('corrupt readback') : read(file, ...args);
    try {
      await assert.rejects(
        device.saveGroups([{ ...group, image: 'groups/new-image.png', display: 'image' }], {
          ownedIds: ['bedtime'],
          icons: new Map([['groups/new-image.png', source]]),
        }),
        /did not verify/,
      );
    } finally {
      fs.readFile = read;
    }
    assert.equal(await fs.readFile(metadata, 'utf8'), before);
    await assert.rejects(fs.stat(path.join(device.root, 'sync.lock')), { code: 'ENOENT' });
  }));
