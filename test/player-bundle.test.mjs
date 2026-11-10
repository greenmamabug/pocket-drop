// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createPlayerBundleManifest,
  verifyPlayerBundle,
  locatePlayerBundle,
} from '../app/player-bundle.mjs';
const temporary = async (fn) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Pocket Drop signed tools '));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};
const fixture = async (root) => {
  const folder = path.join(root, 'firmware-tools');
  for (const file of [
    'mtk/mtk',
    'e2fs/debugfs',
    'e2fs/e2fsck',
    'e2fs/dumpe2fs',
    'mtk/_internal/Python',
  ]) {
    await fs.mkdir(path.dirname(path.join(folder, file)), { recursive: true });
    await fs.writeFile(path.join(folder, file), 'verified native fixture', { mode: 0o755 });
  }
  await fs.symlink('_internal/Python', path.join(folder, 'mtk', 'Python'));
  await fs.writeFile(
    path.join(folder, 'manifest.json'),
    JSON.stringify(await createPlayerBundleManifest(folder, 'x64')),
  );
  return folder;
};
test('signed tool manifest verifies a stable runtime, filenames with spaces and internal links', () =>
  temporary(async (root) => {
    const folder = await fixture(root);
    const first = await verifyPlayerBundle(folder, 'x64');
    const stat = await fs.stat(path.join(first.mtk, 'mtk'));
    assert.deepEqual(await verifyPlayerBundle(folder, 'x64'), first);
    assert.equal((await fs.stat(path.join(first.mtk, 'mtk'))).ino, stat.ino);
    const moduleURL = pathToFileURL(path.join(root, 'app.asar', 'app', 'player-bundle.mjs')).href;
    assert.deepEqual(await locatePlayerBundle('x64', { platform: 'darwin', moduleURL }), first);
    assert.equal(await locatePlayerBundle('x64', { platform: 'linux', moduleURL }), null);
    assert.equal(
      await locatePlayerBundle('x64', { platform: 'darwin', moduleURL: import.meta.url }),
      null,
    );
  }));
test('changed, added, missing or redirected updater files fail verification before native execution', () =>
  temporary(async (root) => {
    const folder = await fixture(root),
      file = path.join(folder, 'mtk', '_internal', 'Python');
    await fs.writeFile(file, 'corrupted');
    await assert.rejects(verifyPlayerBundle(folder, 'x64'), /changed/);
    await fs.writeFile(file, 'verified native fixture');
    await fs.writeFile(path.join(folder, 'mtk', 'injected.py'), 'not in signed manifest');
    await assert.rejects(verifyPlayerBundle(folder, 'x64'), /changed/);
    await fs.rm(path.join(folder, 'mtk', 'injected.py'));
    await fs.rm(path.join(folder, 'mtk', 'Python'));
    await fs.symlink('/etc/passwd', path.join(folder, 'mtk', 'Python'));
    await assert.rejects(verifyPlayerBundle(folder, 'x64'), /outside/);
  }));
test('wrong-architecture and incomplete runtime manifests cannot silently fall back to downloaded tools', () =>
  temporary(async (root) => {
    const folder = await fixture(root);
    await assert.rejects(verifyPlayerBundle(folder, 'arm64'), /does not match/);
    await fs.rm(path.join(folder, 'e2fs', 'e2fsck'));
    await fs.writeFile(
      path.join(folder, 'manifest.json'),
      JSON.stringify(await createPlayerBundleManifest(folder, 'x64')),
    );
    await assert.rejects(verifyPlayerBundle(folder, 'x64'), /executable is missing/);
  }));
