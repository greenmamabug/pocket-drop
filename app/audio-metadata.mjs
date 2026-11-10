// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
export function durationFromManifest(manifest) {
  const tracks = manifest?.tracks;
  if (
    !Array.isArray(tracks) ||
    !tracks.length ||
    tracks.some((t) => !Number.isFinite(t.durationMs) || t.durationMs < 0)
  )
    return null;
  const total = tracks.reduce((n, t) => n + t.durationMs, 0);
  return total > 0 ? total : null;
}

export function preparedDurations(prepared, previous = {}) {
  const tracks = { ...previous },
    aliases = new Map();
  for (const key of prepared.info.audioFiles) {
    aliases.set(key, key);
    if (/\.(opus|ogg)$/i.test(key)) aliases.set(key.replace(/\.(opus|ogg)$/i, '.m4a'), key);
  }
  for (const track of prepared.playlist.tracks) {
    const relative = path.relative(prepared.root, track.localPath).split(path.sep).join('/'),
      key = aliases.get(relative);
    if (key && Number.isFinite(track.entry.durationMs)) tracks[key] = track.entry.durationMs;
  }
  return {
    tracks,
    complete: prepared.info.audioFiles.every(
      (key) => Number.isFinite(tracks[key]) && tracks[key] > 0,
    ),
  };
}

export function cachedDuration(row, item = {}) {
  const record = item.durations,
    keys = item.edits?.tracks.filter((t) => !t.excluded).map((t) => t.key);
  if (record?.fp === row.sourceFingerprint) {
    const wanted = keys ?? (record.complete ? Object.keys(record.tracks) : []);
    if (
      wanted.length &&
      wanted.every((key) => Number.isFinite(record.tracks[key]) && record.tracks[key] > 0)
    )
      return wanted.reduce((n, key) => n + record.tracks[key], 0);
  }
  if (
    item.prepared?.fp === row.sourceFingerprint &&
    item.prepared.editRevision === row.editRevision &&
    Number.isFinite(item.prepared.durationMs)
  )
    return item.prepared.durationMs;
  return row.edited ? null : (row.durationMs ?? null);
}
