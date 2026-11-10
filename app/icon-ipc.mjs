// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dimensions } from './artwork.mjs';
import { YotoAccount, YOTO_SETUP } from './yoto-account.mjs';
import { IconCatalog } from './icon-catalog.mjs';

export async function installIcons({
  app,
  library,
  workspace,
  handle,
  shell,
  net,
  nativeImage,
  safeStorage,
}) {
  const account = await new YotoAccount({
    folder: app.getPath('userData'),
    storage: safeStorage,
    openExternal: (url) => shell.openExternal(url),
    fetcher: (...args) => net.fetch(...args),
    changed: (status) => {
      library.yotoAccount = status;
      library.publish();
    },
  }).load();
  const catalog = new IconCatalog({
    account,
    fetcher: (...args) => net.fetch(...args),
    normalize: (bytes) => {
      const size = dimensions(bytes);
      if (!size || size.width * size.height > 1024 ** 2)
        throw new Error('This icon image is too large or unreadable.');
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error('This icon cannot be read.');
      return image.resize({ width: 16, height: 16, quality: 'best' }).toPNG();
    },
  });
  handle('yotoConnect', (clientId) => account.connect(clientId));
  handle('yotoCancel', () => account.cancel());
  handle('yotoDisconnect', () => account.disconnect());
  handle('yotoSetup', () => shell.openExternal(YOTO_SETUP));
  handle('searchIcons', async (id, source, query, page) => {
    const session = workspace.editor.session(id);
    const result = await catalog.search(id, source, query, page);
    if (workspace.editor.session(id) !== session) throw new Error('Audio details have closed.');
    return result;
  });
  handle('chooseRemoteIcon', async (id, key) => {
    const session = workspace.editor.session(id),
      result = catalog.take(id, key);
    const folder = path.join(workspace.catalog.folder, 'artwork');
    await fs.mkdir(folder, { recursive: true });
    const name = randomUUID() + '.png',
      out = path.join(folder, name);
    await fs.writeFile(out, result.png, { flag: 'wx', mode: 0o600 });
    try {
      if (workspace.editor.session(id) !== session) throw new Error('Audio details have closed.');
    } catch (error) {
      await fs.rm(out, { force: true });
      throw error;
    }
    const ref = 'asset:' + name;
    session.allowedAssets.add(ref);
    return { key: ref, url: workspace.editor.url(out, id), name: result.name };
  });
  handle('iconSourceWebsite', (source, query = '') => {
    if (typeof query !== 'string' || query.length > 80) throw new Error('Search is too long.');
    return shell.openExternal(
      source === 'community'
        ? 'https://yotoicons.com/icons?' + new URLSearchParams({ tag: query }).toString()
        : 'https://yoto.dev/icons/using-icons/',
    );
  });
  app.on('before-quit', () => account.cancel());
  const close = workspace.editor.close.bind(workspace.editor);
  workspace.editor.close = async (id) => {
    catalog.close(id);
    return close(id);
  };
  return account;
}
