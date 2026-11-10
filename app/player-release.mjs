// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

// Intentionally pinned: a newer firmware engine/release needs compatibility review.
export const PLAYER_VERSION = '0.7.0';
export const PLAYER_RELEASE = 'https://github.com/MYO-Studio/studio-pocket/releases/tag/v0.7.0';
export const PLAYER_SIGNER = 'c1a8d7e7f71a3fc07e2fb830c79338aa927ca2092ca9305734db5b60fa0de8fe';
export const PLAYER_ASSETS = {
  apk: {
    name: 'StudioPocket-0.7.0.apk',
    size: 883600,
    sha256: 'a87d5497839b90a6be60101d2990a67e0819e7bcdef491a7aee7c8e5d1fff8dd',
  },
  e2fs: {
    name: 'e2fsprogs-macos-universal.tar.gz',
    size: 1471950,
    sha256: '396fb2956acda981cc2de4402381b79c17e0cdc59fbb7e7413bc442fae2d555a',
  },
  x64: {
    name: 'mtkclient-macos-x64.tar.gz',
    size: 13204260,
    sha256: 'e76a16491507d94e8a29c471e9a6bdd418a32c0cd4a459a7991cea0dffa68562',
  },
  arm64: {
    name: 'mtkclient-macos-arm64.tar.gz',
    size: 12371553,
    sha256: '628d5c188f8cdb057d73a28ab7c287e4a21be899dda7109b5c86ece79d7488fa',
  },
};
export async function verifyAsset(file, asset) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.size)
    throw new Error('Update file size/type did not verify: ' + asset.name);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== asset.sha256)
    throw new Error('Update checksum did not verify: ' + asset.name);
  return file;
}
export async function downloadAsset(folder, asset, { fetcher = fetch, progress = () => {} } = {}) {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, asset.name);
  try {
    return await verifyAsset(file, asset);
  } catch {}
  const temporary = file + '.' + randomUUID() + '.part';
  const abort = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort.abort(), 60000);
  };
  let handle,
    reader,
    total = 0;
  try {
    arm();
    const response = await fetcher(
      'https://github.com/MYO-Studio/studio-pocket/releases/download/v0.7.0/' + asset.name,
      { signal: abort.signal },
    );
    if (!response.ok || !response.body)
      throw new Error('Could not download ' + asset.name + '. Try again when online.');
    reader = response.body.getReader();
    handle = await fs.open(temporary, 'wx', 0o600);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      total += value.length;
      if (total > asset.size) throw new Error('Update download exceeded its expected size.');
      await handle.writeFile(value);
      progress(asset.name, total, asset.size);
    }
    await handle.close();
    handle = null;
    await verifyAsset(temporary, asset);
    await fs.rename(temporary, file);
    return file;
  } catch (error) {
    if (error.name === 'AbortError' || error.message === 'fetch failed')
      throw new Error(
        'The player update download could not finish. Check your internet connection and try again.',
      );
    throw error;
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => {});
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true });
  }
}
