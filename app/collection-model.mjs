// SPDX-License-Identifier: GPL-3.0-only
// Pure collection rules shared by the desktop adapters and renderer.
export const COLLECTION_LOOKS = {
  icon: 'Icon',
  image: 'Picture',
  covers: 'Cover trio',
  recent: 'Recent covers',
};
export function collectionLook(group) {
  return Object.hasOwn(COLLECTION_LOOKS, group.display) ? group.display : 'icon';
}
export function withCollectionMembers(group, playlists) {
  return {
    ...group,
    playlists,
    ...(group.covers ? { covers: group.covers.filter((id) => playlists.includes(id)) } : {}),
  };
}
export function collectionAppearance(group) {
  return {
    id: group.id,
    title: group.title,
    icon: group.icon ?? null,
    playlists: group.playlists,
    display: collectionLook(group),
    image: group.image ?? null,
    covers: group.covers ?? [],
  };
}
export function collectionPreview(group, rows, picture, recent = []) {
  const display = collectionLook(group);
  const icon = { kind: 'icon', src: picture?.thumbnail ?? null, title: group.title };
  if (display === 'icon') return [icon];
  const cards = [];
  if (group.image && (picture?.cardThumbnail || picture?.thumbnail))
    cards.push({
      kind: 'image',
      src: picture.cardThumbnail ?? picture.thumbnail,
      title: group.title,
    });
  if (display === 'image') return cards.length ? cards : [icon];
  const order =
    display === 'covers'
      ? (group.covers ?? [])
      : [
          ...new Set([
            ...recent.slice(0, 5).filter((id) => group.playlists.includes(id)),
            ...group.playlists,
          ]),
        ];
  for (const id of order) {
    if (cards.length === 3) break;
    if (!group.playlists.includes(id)) continue;
    const matches = rows.filter((r) => r.id === id && !r.hidden && r.cover);
    const row = matches.find((r) => r.local) ?? matches[0];
    if (row) cards.push({ kind: 'cover', src: row.cover, title: row.title });
  }
  return cards.length ? cards : [icon];
}
