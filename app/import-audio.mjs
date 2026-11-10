// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tree, LIMITS } from './archive.mjs';
export async function importAudio(paths, inbox, { onImported = async () => {} } = {}) {
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.length > 100 ||
    paths.some((p) => typeof p !== 'string' || !path.isAbsolute(p))
  )
    throw new Error('Choose up to 100 ZIP or 7z files or audio folders.');
  await fs.mkdir(inbox, { recursive: true });
  const inboxReal = await fs.realpath(inbox),
    jobs = [],
    targets = new Set();
  let alreadyInInbox = 0,
    total = 0;
  for (const source of [...new Set(paths)]) {
    const st = await fs.lstat(source);
    if (st.isSymbolicLink()) throw new Error('Symbolic links are not supported.');
    const real = await fs.realpath(source),
      rel = path.relative(inboxReal, real);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      alreadyInInbox++;
      continue;
    }
    const back = path.relative(real, inboxReal);
    if (back === '' || (!back.startsWith('..') && !path.isAbsolute(back)))
      throw new Error('Choose an audio folder, rather than a folder containing your Inbox.');
    if (!st.isDirectory() && (!st.isFile() || !/\.(zip|7z)$/i.test(source)))
      throw new Error(
        'Drop ZIP or 7z archives or folders of audio. Put loose MP3 files together in a folder first.',
      );
    if (st.size > LIMITS.total) throw new Error('This import exceeds the 12 GB processing limit.');
    const files = st.isDirectory() ? await tree(source) : null;
    total += files ? files.reduce((n, f) => n + f.size, 0) : st.size;
    const target = path.join(inboxReal, path.basename(source)),
      key = target.toLowerCase();
    if (targets.has(key) || (await fs.lstat(target).catch(() => null)))
      throw new Error('An item with that name is already in the Inbox. No files were overwritten.');
    targets.add(key);
    jobs.push({ source, target });
  }
  if (!jobs.length) return { imported: 0, alreadyInInbox };
  const free = await fs.statfs(inboxReal);
  if (total + 16 * 1024 ** 2 > Number(free.bavail) * Number(free.bsize))
    throw new Error('Not enough space on your Mac to copy these items into the Inbox.');
  let imported = 0;
  for (const { source, target } of jobs) {
    const staging = path.join(inboxReal, '.import-' + randomUUID());
    try {
      await fs.cp(source, staging, {
        recursive: true,
        errorOnExist: true,
        force: false,
        dereference: false,
      });
      // A source folder can change during a copy. Refuse newly introduced links.
      if ((await fs.lstat(staging)).isDirectory()) await tree(staging);
      if (await fs.lstat(target).catch(() => null))
        throw new Error('An item with that name appeared in the Inbox. Nothing was overwritten.');
      await fs.rename(staging, target);
      imported++;
      await onImported(path.basename(source));
    } catch (error) {
      throw new Error(
        (imported ? imported + ' item(s) were copied before this error. ' : '') + error.message,
      );
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  return { imported, alreadyInInbox };
}
