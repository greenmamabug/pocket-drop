// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAYER_ASSETS } from './player-release.mjs';

async function inventory(folder) {
  const root = await fs.realpath(folder),
    entries = [];
  let bytes = 0;
  async function walk(relative = '') {
    const names = (await fs.readdir(path.join(root, relative))).sort();
    for (const name of names) {
      const key = relative ? relative + '/' + name : name;
      if (key === 'manifest.json') continue;
      if (key.length > 600 || entries.length >= 5000)
        throw new Error('The updater bundle has an unexpected layout.');
      const file = path.join(root, key),
        stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(file),
          actual = await fs.realpath(file);
        if (path.isAbsolute(target) || !actual.startsWith(root + path.sep))
          throw new Error('An updater runtime link points outside the app.');
        entries.push({ path: key, type: 'link', target });
      } else if (stat.isDirectory()) {
        entries.push({ path: key, type: 'directory' });
        await walk(key);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (stat.size > 128 * 1024 ** 2 || bytes > 500 * 1024 ** 2)
          throw new Error('The updater bundle is unexpectedly large.');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        entries.push({
          path: key,
          type: 'file',
          size: stat.size,
          executable: !!(stat.mode & 0o111),
          sha256: hash.digest('hex'),
        });
      } else throw new Error('The updater bundle contains an unsupported file.');
    }
  }
  await walk();
  return entries;
}

export async function createPlayerBundleManifest(folder, arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unknown updater architecture.');
  return {
    format: 'pocket-drop-firmware-tools',
    version: 1,
    arch,
    archives: { mtk: PLAYER_ASSETS[arch].sha256, e2fs: PLAYER_ASSETS.e2fs.sha256 },
    files: await inventory(folder),
  };
}

export async function verifyPlayerBundle(folder, arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unknown updater architecture.');
  const root = await fs.lstat(folder);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error('The updater runtime folder is not valid.');
  const manifestFile = path.join(folder, 'manifest.json'),
    stat = await fs.lstat(manifestFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 ** 2)
    throw new Error('The updater runtime manifest is not valid.');
  const expected = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  if (
    expected.format !== 'pocket-drop-firmware-tools' ||
    expected.version !== 1 ||
    expected.arch !== arch ||
    expected.archives?.mtk !== PLAYER_ASSETS[arch]?.sha256 ||
    expected.archives?.e2fs !== PLAYER_ASSETS.e2fs.sha256 ||
    !Array.isArray(expected.files)
  )
    throw new Error('The updater runtime does not match this app.');
  const actual = await inventory(folder);
  if (JSON.stringify(actual) !== JSON.stringify(expected.files))
    throw new Error(
      'The built-in updater files changed. Replace Pocket Drop with a fresh download. Nothing was written to the player.',
    );
  for (const key of ['mtk/mtk', 'e2fs/debugfs', 'e2fs/e2fsck', 'e2fs/dumpe2fs']) {
    if (!actual.some((entry) => entry.path === key && entry.type === 'file' && entry.executable))
      throw new Error('A built-in updater executable is missing. Reinstall Pocket Drop.');
  }
  return { e2fs: path.join(folder, 'e2fs'), mtk: path.join(folder, 'mtk'), source: 'bundled' };
}

export async function locatePlayerBundle(
  arch,
  { platform = process.platform, moduleURL = import.meta.url } = {},
) {
  const file = fileURLToPath(moduleURL);
  if (platform !== 'darwin' || !file.includes(path.sep + 'app.asar' + path.sep)) return null;
  // In the distributed app this lives beside app.asar, outside its virtual filesystem.
  return verifyPlayerBundle(fileURLToPath(new URL('../../firmware-tools/', moduleURL)), arch);
}
