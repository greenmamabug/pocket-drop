// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from 'node:crypto';
const canonical = (groups) =>
  groups.map((g) => ({ id: g.id, title: g.title, icon: g.icon ?? null, playlists: g.playlists }));
export function collectionRevision(data) {
  const groups = canonical(data.groups ?? []),
    pictures = groups.map((g) => [
      g.id,
      data.collectionPictures?.[g.id]?.ref ?? null,
      data.collectionPictures?.[g.id]?.iconRef ?? null,
    ]);
  return createHash('sha256').update(JSON.stringify({ groups, pictures })).digest('hex');
}
export function collectionsPending(device, data) {
  if (!device.connected || !device.initialized) return false;
  const wanted = data.groups ?? [],
    owned = new Set([...(data.ownedGroups ?? []), ...wanted.map((g) => g.id)]),
    actual = (device.check?.groups?.groups ?? []).filter((g) => owned.has(g.id));
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(wanted))) return true;
  const saved = data.collectionsSynced?.[device.deviceId],
    hasPictures = wanted.some((g) => data.collectionPictures?.[g.id]?.iconRef);
  return (hasPictures || saved !== undefined) && saved !== collectionRevision(data);
}
