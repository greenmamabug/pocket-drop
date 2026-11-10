// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { liveWindow, showWindow } from './window-lifecycle.mjs';
import { Workspace } from './workspace.mjs';
import { mediaResponse } from './media.mjs';
import { checkUpdate } from './updates.mjs';
import { revision, text } from './catalog.mjs';
import { fingerprint } from './archive.mjs';
import { dimensions } from './artwork.mjs';
import { makeCollectionPicture, checkedCollectionPicture } from './collection-artwork.mjs';
import { withCollectionMembers } from './collection-model.mjs';
import { validateGroups } from '@studio-pocket/library-format';
export const DOWNLOADS = 'https://github.com/greenmamabug/pocket-drop/releases';

export async function installStudio({
  app,
  win,
  library,
  catalog,
  config,
  updateSettings,
  handle,
  idle,
  dialog,
  shell,
  nativeImage,
  Notification,
  protocol,
  net,
}) {
  const notify = (title, body) => {
    if (
      config.completionNotifications &&
      (!liveWindow(win) || !win.isFocused() || !win.isVisible()) &&
      Notification.isSupported()
    ) {
      const notification = new Notification({ title, body });
      notification.on('click', () => {
        showWindow(win, { focus: true });
        app.dock?.show();
      });
      notification.show();
    }
  };
  const collectionArt = { nativeImage, editor: null, folder: catalog.folder };
  const renderCover = async (ref, edits) => {
    const source = workspace.editor.asset(ref),
      image = nativeImage.createFromPath(source);
    if (image.isEmpty()) throw new Error('The selected cover cannot be read.');
    const size = image.getSize();
    let output = image;
    if (edits.coverMode === 'fill') {
      const scale = Math.max(540 / size.width, 856 / size.height),
        resized = image.resize({
          width: Math.max(540, Math.round(size.width * scale)),
          height: Math.max(856, Math.round(size.height * scale)),
          quality: 'best',
        }),
        bounds = resized.getSize();
      output = resized.crop({
        x: Math.round((bounds.width - 540) / 2),
        y: Math.round(((bounds.height - 856) * (edits.coverPosition ?? 50)) / 100),
        width: 540,
        height: 856,
      });
    } else if (size.height > 856 || size.width > 856) {
      const scale = Math.min(856 / size.height, 856 / size.width);
      output = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'best',
      });
    }
    const folder = path.join(catalog.folder, 'rendered-artwork');
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(
      folder,
      revision({ ref, mode: edits.coverMode, position: edits.coverPosition }) + '.png',
    );
    await fs.writeFile(file, output.toPNG());
    return file;
  };
  const workspace = new Workspace(library, catalog, { renderCover, notify });
  collectionArt.editor = workspace.editor;
  protocol.handle('pocket-media', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'preview') return new Response(null, { status: 404 });
      const file = await workspace.editor.mediaFile(url.pathname.slice(1));
      return file ? mediaResponse(file, request) : new Response(null, { status: 404 });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  let lastResult = null;
  library.on('change', () => {
    const result = library.lastResult;
    if (result?.id && result.id !== lastResult && !library.busy && !workspace.syncingCollections) {
      lastResult = result.id;
      notify(
        result.tone === 'error'
          ? 'Pocket Drop needs attention'
          : result.kind === 'remove'
            ? 'Removal finished'
            : 'Sync finished',
        result.message,
      );
    }
  });
  handle('openEditor', (key) => workspace.open(key));
  handle('editorMetrics', (id) => workspace.editor.metrics(id));
  handle('closeEditor', async (id) => {
    await workspace.editor.close(id);
    library.rows = library.rows.map((row) => catalog.decorate(row));
    library.publish();
    workspace.durations.schedule();
  });
  handle('saveEditor', async (id, input) => {
    await workspace.save(id, input);
    const item = catalog.get(workspace.editor.session(id).rowKey);
    if (item.edits.coverRef) {
      const file = await renderCover(item.edits.coverRef, item.edits),
        image = nativeImage.createFromPath(file);
      await catalog.set(workspace.editor.session(id).rowKey, {
        coverData: image.resize({ height: 160, quality: 'best' }).toDataURL(),
      });
      await library.scan(true);
    }
    return { saved: true };
  });
  handle('pickArtwork', async (id, kind) => {
    idle();
    const session = workspace.editor.session(id);
    if (!['cover', 'icon'].includes(kind)) throw new Error('Choose cover or track icon.');
    const result = await dialog.showOpenDialog(win, {
      title: kind === 'icon' ? 'Choose a track icon' : 'Choose cover artwork',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (result.canceled) return null;
    const file = result.filePaths[0],
      st = await fs.lstat(file);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 10 * 1024 ** 2)
      throw new Error('Choose an image smaller than 10 MB.');
    let image = nativeImage.createFromPath(file);
    if (image.isEmpty()) throw new Error('This image cannot be read.');
    const size = image.getSize();
    if (size.width * size.height > 50_000_000) throw new Error('This image has too many pixels.');
    if (kind === 'icon') image = image.resize({ width: 16, height: 16, quality: 'best' });
    else if (Math.max(size.width, size.height) > 1600) {
      const scale = 1600 / Math.max(size.width, size.height);
      image = image.resize({
        width: Math.round(size.width * scale),
        height: Math.round(size.height * scale),
        quality: 'best',
      });
    }
    const folder = path.join(catalog.folder, 'artwork');
    await fs.mkdir(folder, { recursive: true });
    const name = randomUUID() + '.png',
      out = path.join(folder, name);
    await fs.writeFile(out, image.toPNG(), { flag: 'wx' });
    const key = 'asset:' + name;
    session.allowedAssets.add(key);
    return { key, url: workspace.editor.url(out, id), name: path.basename(file) };
  });
  handle('prepareAudio', (keys) => workspace.prepareAudio(keys));
  handle('cancelPreparation', () => {
    workspace.cancelPreparation?.();
    return { cancelled: true };
  });
  handle('undoRemoval', async () => {
    idle();
    const undo = catalog.data.undo;
    if (!undo?.items?.length) throw new Error('No recent removal is available to undo.');
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      message: `Restore ${undo.items.length} audio item(s) to Pocket?`,
      detail:
        'This copies the unchanged Inbox originals back to the same player, using their saved edits.',
      buttons: ['Cancel', 'Restore to Pocket'],
      cancelId: 0,
      defaultId: 1,
    });
    if (result.response === 1) await workspace.undoRemoval();
  });
  handle('compareDuplicates', (keys) => workspace.compareDuplicates(keys));
  handle('preferImport', async (keys, preferred) => {
    idle();
    if (!Array.isArray(keys) || keys.length > 20 || !keys.includes(preferred))
      throw new Error('Choose a preferred import from this comparison.');
    const rows = keys.map((k) => workspace.row(k));
    if (rows.some((r) => !r.local) || new Set(rows.map((r) => r.id)).size !== 1)
      throw new Error('Only matching local editions can be hidden together.');
    for (const row of rows) await catalog.set(row.key, { hidden: row.key !== preferred });
    await library.scan(true);
  });
  handle('restoreHidden', async (key) => {
    idle();
    workspace.row(key);
    await catalog.set(key, { hidden: false });
    await library.scan(true);
  });
  handle('pickCollectionPicture', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a collection picture',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (result.canceled) return null;
    const st = await fs.lstat(result.filePaths[0]);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 10 * 1024 ** 2)
      throw new Error('Choose an image smaller than 10 MB.');
    const bytes = await fs.readFile(result.filePaths[0]),
      size = dimensions(bytes);
    if (!size || size.width * size.height > 50_000_000)
      throw new Error('Choose a PNG, JPEG or WebP image with fewer than 50 million pixels.');
    return makeCollectionPicture(collectionArt, bytes);
  });
  const picturePaths = (group, picture) => ({
    ...group,
    icon: picture ? `groups/${group.id}-${revision(picture.iconRef).slice(0, 10)}.png` : group.icon,
    image:
      picture?.imageRef && group.image
        ? `groups/${group.id}-image-${revision(picture.imageRef).slice(0, 10)}.png`
        : (group.image ?? null),
  });
  handle('saveCollections', async (groups, changes = {}) => {
    idle();
    groups = validateGroups({
      format: 'studiopocket-groups',
      formatVersion: 1,
      updatedAt: new Date().toISOString(),
      generator: 'Pocket Drop',
      groups,
    }).groups;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes))
      throw new Error('Invalid collection picture changes.');
    const pictures = { ...(catalog.data.collectionPictures ?? {}) };
    for (const [id, picture] of Object.entries(changes)) {
      if (!groups.some((g) => g.id === id)) throw new Error('Unknown collection picture.');
      if (picture === null) {
        delete pictures[id];
        continue;
      }
      pictures[id] = await checkedCollectionPicture(collectionArt, picture, { needCard: true });
    }
    // Lazily add portrait cards for existing circular pictures when requested.
    for (const group of groups) {
      const picture = pictures[group.id];
      if (picture && group.image && !picture.imageRef)
        pictures[group.id] = await checkedCollectionPicture(collectionArt, picture, {
          needCard: true,
        });
    }
    groups = groups.map((g) => picturePaths(g, pictures[g.id]));
    await catalog.groups(groups, pictures);
    library.publish();
    return catalog.data.groups;
  });
  handle('importCollections', async () => {
    idle();
    workspace.requireNoPreparation();
    library.busy = true;
    library.operation = 'collections-read';
    library.publish();
    try {
      const groups = library.deviceState.check?.groups?.groups;
      if (!groups) throw new Error('No readable collections were found on Pocket.');
      const existing = catalog.data.groups;
      const assigned = new Set(existing.flatMap((g) => g.playlists));
      const added = groups
        .filter((g) => !existing.some((e) => e.id === g.id))
        .map((g) =>
          withCollectionMembers(
            g,
            g.playlists.filter((id) => !assigned.has(id)),
          ),
        );
      const pictures = { ...(catalog.data.collectionPictures ?? {}) };
      const guard = await library.device.pin();
      for (const group of added) {
        const image = group.image
          ? await library.device.collectionArtwork(group.image, guard)
          : null;
        const icon = group.icon ? await library.device.collectionArtwork(group.icon, guard) : null;
        if (!image) group.image = null;
        if (image || icon)
          pictures[group.id] = await makeCollectionPicture(collectionArt, image ?? icon, icon);
      }
      await guard();
      const merged = [...existing, ...added.map((g) => picturePaths(g, pictures[g.id]))];
      await catalog.groups(merged, pictures);
      library.publish();
      return catalog.data.groups;
    } finally {
      library.busy = false;
      library.operation = null;
      library.publish();
    }
  });
  handle('applyCollections', async () => {
    idle();
    workspace.requireNoPreparation();
    if (!library.deviceState.connected) throw new Error('Connect Pocket to sync collections.');
    const plan = workspace.collectionPlan();
    const choice = await dialog.showMessageBox(win, {
      type: 'question',
      message: 'Sync collections to Pocket?',
      detail: `${plan.groups.length} collection(s). ${plan.keys.length} audio item(s) will be added or updated, then their pictures, order, and collection membership will be synced. Available space is checked before writing. Other collections and listening history are preserved.`,
      buttons: ['Cancel', 'Sync Collections'],
      cancelId: 0,
      defaultId: 1,
    });
    if (choice.response === 1) await workspace.syncCollections(plan);
  });
  handle('trashExcluded', async (id) => {
    idle();
    workspace.requireNoPreparation();
    const session = workspace.editor.session(id);
    if (!session.doc.isFolder)
      throw new Error(
        'Individual originals inside an archive cannot be moved to Trash. Delete from this version keeps the archive unchanged.',
      );
    const edits = catalog.get(session.rowKey).edits,
      excluded = edits?.tracks.filter((t) => t.excluded) ?? [];
    if (!excluded.length) throw new Error('Save some excluded tracks first.');
    if ((await fingerprint(session.source)) !== session.fp)
      throw new Error('The original files changed. Reopen Audio details.');
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      message: `Move ${excluded.length} original audio file(s) to Trash?`,
      detail:
        excluded.map((t) => path.basename(t.key)).join('\n') +
        '\n\nThese files will leave your Inbox folder. Use Finder’s Trash to restore them. Files already on Pocket are kept until you sync the edited version.',
      buttons: ['Keep originals', 'Move originals to Trash'],
      cancelId: 0,
      defaultId: 0,
    });
    if (choice.response !== 1) return { cancelled: true };
    const root = await fs.realpath(session.source),
      done = [];
    try {
      for (const t of excluded) {
        const file = path.join(session.doc.root, t.key),
          real = await fs.realpath(file),
          back = path.relative(root, real),
          st = await fs.lstat(file);
        if (st.isSymbolicLink() || !st.isFile() || back.startsWith('..') || path.isAbsolute(back))
          throw new Error('Unsafe original file path.');
        await shell.trashItem(file);
        done.push(t.key);
      }
    } catch (error) {
      throw new Error(
        `${done.length} original file(s) moved to Trash before an error: ${error.message}`,
      );
    } finally {
      if (done.length) {
        await catalog.set(session.rowKey, {
          edits: { ...edits, tracks: edits.tracks.filter((t) => !done.includes(t.key)) },
        });
        await workspace.editor.close(id);
        await library.scan(true);
      }
    }
    return { trashed: done.length };
  });
  handle('completionNotifications', async (enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid notification setting.');
    await updateSettings({ completionNotifications: enabled });
    library.publish();
  });
  handle('updateRepository', async (value) => {
    if (typeof value !== 'string' || (value && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)))
      throw new Error('Enter owner/repository, or leave it blank.');
    await updateSettings({ updateRepository: value });
    library.publish();
  });
  let update = null;
  handle('checkUpdates', async () => {
    update = await checkUpdate(config.updateRepository, app.getVersion(), process.arch, {
      fetcher: (url, options) => net.fetch(url, options),
    });
    return update;
  });
  handle('downloadUpdate', () => {
    if (!update?.url) throw new Error('Check for an update with a download for this Mac first.');
    return shell.openExternal(update.url);
  });
  handle('openDownloads', () => shell.openExternal(DOWNLOADS));
  return workspace;
}
