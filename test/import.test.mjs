import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { importAudio } from '../app/import-audio.mjs';
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-import-')),
    inbox = path.join(root, 'Inbox');
  await fs.mkdir(inbox);
  return { root, inbox, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
test('ZIP and audio folder imports copy bytes, preserve originals, and skip existing Inbox items', async () => {
  const s = await setup();
  try {
    const zip = path.join(s.root, 'Story.zip'),
      folder = path.join(s.root, 'Music');
    await fs.writeFile(zip, 'original ZIP bytes');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, '01.mp3'), 'source audio');
    const imported = [];
    assert.deepEqual(
      await importAudio([zip, folder], s.inbox, { onImported: (name) => imported.push(name) }),
      { imported: 2, alreadyInInbox: 0 },
    );
    assert.equal(await fs.readFile(zip, 'utf8'), 'original ZIP bytes');
    assert.equal(await fs.readFile(path.join(s.inbox, 'Story.zip'), 'utf8'), 'original ZIP bytes');
    assert.equal(await fs.readFile(path.join(folder, '01.mp3'), 'utf8'), 'source audio');
    assert.equal(imported.length, 2);
    assert.deepEqual(await importAudio([path.join(s.inbox, 'Story.zip')], s.inbox), {
      imported: 0,
      alreadyInInbox: 1,
    });
  } finally {
    await s.cleanup();
  }
});
test('bad drop preflight copies no partial batch and never overwrites names', async () => {
  const s = await setup();
  try {
    const zip = path.join(s.root, 'Story.zip'),
      loose = path.join(s.root, '01.mp3');
    await fs.writeFile(zip, 'zip');
    await fs.writeFile(loose, 'audio');
    await assert.rejects(importAudio([zip, loose], s.inbox), /loose MP3/);
    assert.deepEqual(await fs.readdir(s.inbox), []);
    await fs.writeFile(path.join(s.inbox, 'Story.zip'), 'keep');
    await assert.rejects(importAudio([zip], s.inbox), /overwritten/);
    assert.equal(await fs.readFile(path.join(s.inbox, 'Story.zip'), 'utf8'), 'keep');
  } finally {
    await s.cleanup();
  }
});
test('drop import refuses symlinks, Inbox ancestors and non-absolute paths', async () => {
  const s = await setup();
  try {
    const zip = path.join(s.root, 'Story.zip'),
      link = path.join(s.root, 'Link.zip');
    await fs.writeFile(zip, 'zip');
    await fs.symlink(zip, link);
    await assert.rejects(importAudio([link], s.inbox), /Symbolic/);
    await assert.rejects(importAudio([s.root], s.inbox), /containing your Inbox/);
    await assert.rejects(importAudio(['relative.zip'], s.inbox), /Choose up to/);
    assert.deepEqual(await fs.readdir(s.inbox), []);
  } finally {
    await s.cleanup();
  }
});
