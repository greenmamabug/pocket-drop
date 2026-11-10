// SPDX-License-Identifier: GPL-3.0-only
// Build-time only. Keep provenance and corresponding sources with the signed Mac app.
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { PLAYER_ASSETS, downloadAsset } from '../app/player-release.mjs';
import { createPlayerBundleManifest } from '../app/player-bundle.mjs';
const exec = promisify(execFile),
  arch = process.argv[2];
if (!['x64', 'arm64'].includes(arch)) throw new Error('Pass the Mac architecture.');
const out = path.resolve('release/firmware-tools'),
  cache = path.resolve('release/player-asset-downloads');
const sources = path.resolve('release/player-tool-sources');
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
await fs.mkdir(sources, { recursive: true });
for (const [key, name] of [
  ['e2fs', 'e2fs'],
  [arch, 'mtk'],
]) {
  const archive = await downloadAsset(cache, PLAYER_ASSETS[key]);
  const target = path.join(out, name);
  await fs.mkdir(target);
  await exec('/usr/bin/tar', ['-xzf', archive, '--no-same-owner', '-C', target]);
}
const sourceAssets = [
  {
    name: 'e2fsprogs-1.47.4.tar.gz',
    size: 10092701,
    sha256: 'da274408bebbfd13a5a2fc3cfc66e3ffff17c48534673aa67f88d49b99123b96',
  },
  {
    name: 'mtkclient-source.tar.gz',
    size: 1896767,
    sha256: '1b4afa49402b4af0a85adb45e497eab1cb0699d7c483652ef01ac668dadf866f',
  },
  {
    name: 'libusb-1.0.30-source.tar.bz2',
    size: 656112,
    sha256: 'fea36f34f9156400209595e300840767ab1a385ede1dc7ee893015aea9c6dbaf',
  },
  {
    name: 'Studio-Pocket-0.7.0-build-source.zip',
    size: 1710579,
    sha256: 'eb579f450670d04962dac5bc79400140deaa0c92fc73eac34b32acccacac835e',
    url: 'https://codeload.github.com/MYO-Studio/studio-pocket/zip/06f11b08ff4a10c9ab4d38ea4000869090298174',
  },
];
for (const asset of sourceAssets)
  await fs.copyFile(await downloadAsset(cache, asset), path.join(sources, asset.name));
await fs.writeFile(
  path.join(out, 'manifest.json'),
  JSON.stringify(await createPlayerBundleManifest(out, arch), null, 2) + '\n',
);
console.log(
  'Staged hash-verified updater tools, licences and matching GPL/LGPL sources. No device opened.',
);
