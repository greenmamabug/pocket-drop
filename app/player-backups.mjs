// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';

// The engine owns fixed work/tmp names: never treat a general personal folder as its workspace.
export async function validateBackupFolder(folder) {
  const real = await fs.realpath(folder);
  if (real === '/' || real === '/Volumes' || real.startsWith('/Volumes/'))
    throw new Error('Choose a dedicated player backup folder on your Mac.');
  const entries = (await fs.readdir(real)).filter((name) => name !== '.DS_Store');
  for (const name of ['work', 'tmp', 'tools', 'units', 'device', 'upgrade', 'stock', 'out']) {
    const stat = await fs.lstat(path.join(real, name)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory()))
      throw new Error('The player backup workspace contains an unsafe folder: ' + name);
  }
  if (!entries.length) return real;
  const marker = await fs
    .readFile(path.join(real, '.pocket-drop-backups.json'), 'utf8')
    .catch(() => '');
  if (marker === '{"format":"pocket-drop-player-backups","version":1}\n') return real;
  // Existing upstream folders, including the original pre-per-player layout.
  try {
    const id = (await fs.readFile(path.join(real, 'current-unit'), 'utf8')).trim();
    if (!/^(?:[0-9a-f]{32}|legacy)$/.test(id)) throw new Error();
    const unit = JSON.parse(await fs.readFile(path.join(real, 'units', id, 'unit.json')));
    if (unit.unitId === id) return real;
  } catch {}
  try {
    const old = JSON.parse(await fs.readFile(path.join(real, 'device', 'device-identity.json')));
    if (old.layout?.android && typeof old.stockImage === 'string') return real;
  } catch {}
  throw new Error(
    'Choose an empty folder or your existing Studio Pocket firmware backup folder. General personal folders cannot be used for player image work.',
  );
}
