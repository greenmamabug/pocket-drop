// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
import { parseFile } from 'music-metadata';

/** Read actual codec duration without allocating embedded cover artwork. */
export async function probeDuration(file) {
  const duration =
    (await parseFile(file, { duration: true, skipCovers: true })).format.duration * 1000;
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error('Cannot read audio length: ' + path.basename(file));
  return Math.round(duration);
}
