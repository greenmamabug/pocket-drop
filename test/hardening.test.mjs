import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeJson, flushJsonWrites } from '../app/atomic-json.mjs';
import { Catalog } from '../app/catalog.mjs';
import { mediaResponse } from '../app/media.mjs';
import { mustFinishBeforeQuit, shouldHideOnClose } from '../app/window-lifecycle.mjs';
import { decodeOpus, convertOpusFile } from '../app/convert-audio.mjs';

async function temporary(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-hardening-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('overlapping JSON writes preserve invocation order, capture snapshots and leave no partials', () =>
  temporary(async (root) => {
    const file = path.join(root, 'settings.json'),
      state = { name: 'First' };
    const first = writeJson(file, state);
    state.name = 'Second';
    const second = writeJson(file, state);
    state.name = 'Not submitted';
    await Promise.all([first, second]);
    await flushJsonWrites();
    assert.deepEqual(JSON.parse(await fs.readFile(file)), { name: 'Second' });
    assert.deepEqual(await fs.readdir(root), ['settings.json']);
  }));
test('failed JSON replacement keeps the last good file and later writes still work', () =>
  temporary(async (root) => {
    const file = path.join(root, 'settings.json');
    await writeJson(file, { name: 'Original' });
    const rename = fs.rename;
    fs.rename = async () => {
      throw new Error('Disk unavailable');
    };
    try {
      await assert.rejects(writeJson(file, { name: 'Broken' }), /unavailable/);
    } finally {
      fs.rename = rename;
    }
    assert.equal(JSON.parse(await fs.readFile(file)).name, 'Original');
    await writeJson(file, { name: 'Recovered' });
    assert.equal(JSON.parse(await fs.readFile(file)).name, 'Recovered');
    assert.deepEqual(await fs.readdir(root), ['settings.json']);
  }));
test('a failed edit cannot leak into a simultaneously queued successful edit', () =>
  temporary(async (root) => {
    const catalog = await new Catalog(root).load();
    await catalog.set('book', { title: 'Original', tags: [] });
    const write = fs.writeFile;
    fs.writeFile = async (file, data, ...rest) => {
      if (String(data).includes('Broken')) throw new Error('Disk is full');
      return write(file, data, ...rest);
    };
    try {
      const result = await Promise.allSettled([
        catalog.set('book', { title: 'Broken' }),
        catalog.set('book', { tags: ['Saved'] }),
      ]);
      assert.equal(result[0].status, 'rejected');
      assert.equal(result[1].status, 'fulfilled');
    } finally {
      fs.writeFile = write;
    }
    const reloaded = await new Catalog(root).load();
    assert.deepEqual(reloaded.get('book'), { title: 'Original', tags: ['Saved'] });
  }));
test('background preparation cannot be hidden instead of protected when opening on connection is enabled', () => {
  assert.equal(mustFinishBeforeQuit({ preparation: { running: true } }), true);
  assert.equal(
    shouldHideOnClose({ preparation: { running: true } }, { openOnConnect: true, quitting: false }),
    false,
  );
  assert.equal(shouldHideOnClose({ busy: false }, { openOnConnect: true, quitting: false }), true);
  assert.equal(shouldHideOnClose({}, { openOnConnect: true, quitting: true }), false);
});
test('unsafe numeric ranges are rejected before clamping to file size', () =>
  temporary(async (root) => {
    const file = path.join(root, 'audio.mp3');
    await fs.writeFile(file, '0123456789');
    for (const range of ['bytes=0-9999999999999999999999', 'bytes=-9999999999999999999999'])
      assert.equal(
        (await mediaResponse(file, new Request('https://local', { headers: { range } }))).status,
        416,
      );
    assert.equal(
      (
        await mediaResponse(
          file,
          new Request('https://local', { headers: { range: 'bytes=0-999' } }),
        )
      ).status,
      206,
    );
  }));
test('progress callback failures reject conversion and terminate the decoder instead of crashing the process', () =>
  temporary(async (root) => {
    await assert.rejects(
      decodeOpus(path.resolve('test/fixtures/tone-mono.opus'), path.join(root, 'audio.caf'), {
        onProgress: () => {
          throw new Error('Progress callback failed');
        },
      }),
      /Progress callback failed/,
    );
  }));
test('cancellation during source hashing avoids launching the encoder', () =>
  temporary(async (root) => {
    let checks = 0,
      encoded = false;
    await assert.rejects(
      convertOpusFile(path.resolve('test/fixtures/tone-mono.opus'), path.join(root, 'output.m4a'), {
        cancelled: () => ++checks >= 2,
        encode: async () => {
          encoded = true;
        },
      }),
      /cancelled/,
    );
    assert.equal(encoded, false);
    assert.deepEqual(await fs.readdir(root), []);
  }));

test('settings patch failures cannot leak into another concurrently submitted setting', () =>
  temporary(async (root) => {
    const { createSettingsWriter } = await import('../app/settings-store.mjs');
    const file = path.join(root, 'settings.json'),
      settings = { font: 14, name: 'Original' },
      update = createSettingsWriter(file, settings);
    await update({});
    const write = fs.writeFile;
    fs.writeFile = async (file, data, ...args) => {
      if (String(data).includes('99')) throw new Error('Disk full');
      return write(file, data, ...args);
    };
    try {
      const results = await Promise.allSettled([update({ font: 99 }), update({ name: 'Saved' })]);
      assert.equal(results[0].status, 'rejected');
      assert.equal(results[1].status, 'fulfilled');
    } finally {
      fs.writeFile = write;
    }
    await update.flush();
    assert.deepEqual(settings, { font: 14, name: 'Saved' });
    assert.deepEqual(JSON.parse(await fs.readFile(file)), settings);
  }));

test('malformed saved groups/edits are rejected without rewriting the saved file', () =>
  temporary(async (root) => {
    for (const data of [
      { version: 1, items: {}, groups: [null] },
      { version: 1, items: { book: { edits: { tracks: [null] } } }, groups: [] },
    ]) {
      const file = path.join(root, 'catalog-v1.json'),
        original = JSON.stringify(data);
      await fs.writeFile(file, original);
      await assert.rejects(new Catalog(root).load(), /Saved library edits could not be read/);
      assert.equal(await fs.readFile(file, 'utf8'), original);
    }
  }));
