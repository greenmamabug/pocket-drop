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
    if (row) cards.push({ kind: 'cover', playlistId: id, src: row.cover, title: row.title });
  }
  return cards.length ? cards : [icon];
}
// The player fans a two-card stack right; three cards fan left, then right.
export function collectionStackSides(count) {
  return count === 3 ? ['front', 'left', 'right'] : ['front', 'right'].slice(0, count);
}
export function collectionCoverLabels(group, rows, picture) {
  const cards = collectionPreview(group, rows, picture).filter((card) => card.kind !== 'icon'),
    pictureFirst = cards[0]?.kind === 'image',
    sides = collectionStackSides(cards.length);
  return Array.from({ length: 3 }, (_, index) => {
    const title = ['First cover', 'Second cover', 'Third cover'][index + Number(pictureFirst)];
    if (!title) return 'Extra cover (not shown with picture)';
    const selected = group.covers?.[index],
      face = selected ? cards.findIndex((card) => card.playlistId === selected) : -1;
    if (face >= 0) return `${title} (${sides[face]})`;
    if (selected) return `${title} (artwork unavailable)`;
    if (cards.length === 3) return `${title} (not shown)`;
    const side = collectionStackSides(cards.length + 1)[cards.length];
    return `${title} (${side}${index ? ' when added' : ''})`;
  });
}
