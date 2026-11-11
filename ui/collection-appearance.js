// SPDX-License-Identifier: GPL-3.0-only
import {
  collectionLook,
  collectionPreview,
  collectionCoverLabels,
} from '../app/collection-model.mjs';

export function collectionStackHTML(group, state, picture, esc) {
  const cards = collectionPreview(
    group,
    state.rows,
    picture,
    state.device.check?.recent?.playlists ?? [],
  );
  const label = cards.map((card) => card.title).join(', ');
  return `<span class="cover-stack ${collectionLook(group) === 'covers' ? 'cover-trio' : ''}" role="img" aria-label="${esc(label)}">${cards.map((card) => `<span class="stack-card ${card.kind === 'icon' ? 'icon-card' : ''}" aria-hidden="true">${card.src ? `<img class="${card.kind === 'icon' ? 'stack-icon' : ''}" src="${esc(card.src)}" alt="">` : '<span class="stack-glyph">♫</span>'}</span>`).join('')}</span>`;
}

export function installCollectionAppearance({ getDraft, getPicture, getState, esc }) {
  const $ = (id) => document.getElementById(id);
  const placeholder = () => 'groups/' + getDraft().id + '-image.png';
  $('collection-look').onchange = () => {
    const group = getDraft();
    group.display = $('collection-look').value;
    if (group.display === 'image' && getPicture()) group.image ||= placeholder();
    if (group.display === 'covers' && !group.covers?.length) {
      group.covers = group.playlists
        .filter((id) => getState().rows.some((r) => r.id === id && r.cover && !r.hidden))
        .slice(0, 3);
    }
    render();
  };
  $('collection-use-picture').onchange = () => {
    getDraft().image = $('collection-use-picture').checked && getPicture() ? placeholder() : null;
    render();
  };
  function render() {
    const group = getDraft(),
      picture = getPicture(),
      state = getState();
    if (!group) return;
    const look = collectionLook(group);
    $('collection-look').value = look;
    $('collection-use-picture-row').hidden = !picture || !['covers', 'recent'].includes(look);
    $('collection-use-picture').checked = !!group.image;
    $('collection-card-preview').innerHTML = collectionStackHTML(group, state, picture, esc);
    $('collection-look-hint').textContent =
      look === 'recent'
        ? 'Recent covers follow listening order on Pocket. This preview uses the last connected player’s recent list, then collection order.'
        : look === 'covers'
          ? 'Two cards: front and right. Three cards: front, left, then right. Hover over Pocket preview to fan them out. A collection picture takes the front position, leaving room for two covers.'
          : look === 'image'
            ? 'The picture fills a portrait card on Pocket. Choose a picture below; the icon is used if none is available.'
            : 'A single card with the collection’s icon. Older players also use this icon.';
    $('collection-cover-choices').hidden = look !== 'covers';
    const covers = group.covers ?? [],
      labels = collectionCoverLabels(group, state.rows, picture);
    const choices = group.playlists.map((id) => ({
      id,
      row: state.rows.find((r) => r.id === id && !r.hidden),
    }));
    $('collection-cover-choices').innerHTML = Array.from(
      { length: 3 },
      (_, index) =>
        `<div class="cover-choice"><label>${labels[index]}<select data-cover-slot="${index}"><option value="">No cover</option>${choices
          .filter(({ id, row }) => row?.cover || covers.includes(id))
          .map(
            ({ id, row }) =>
              `<option value="${esc(id)}" ${covers[index] === id ? 'selected' : ''} ${covers.includes(id) && covers[index] !== id ? 'disabled' : ''}>${esc(row?.title ?? id)}${row?.cover ? '' : ' (artwork unavailable)'}</option>`,
          )
          .join(
            '',
          )}</select></label><span><button class="text-button" data-cover-up="${index}" aria-label="Move cover up" ${index === 0 || index >= covers.length ? 'disabled' : ''}>↑</button><button class="text-button" data-cover-down="${index}" aria-label="Move cover down" ${index >= covers.length - 1 ? 'disabled' : ''}>↓</button></span></div>`,
    ).join('');
    $('collection-cover-choices')
      .querySelectorAll('[data-cover-slot]')
      .forEach((select) => {
        select.onchange = () => {
          const next = [...(group.covers ?? [])];
          next[Number(select.dataset.coverSlot)] = select.value;
          group.covers = [...new Set(next.filter(Boolean))];
          render();
        };
      });
    for (const [attr, offset] of [
      ['coverUp', -1],
      ['coverDown', 1],
    ]) {
      $('collection-cover-choices')
        .querySelectorAll(attr === 'coverUp' ? '[data-cover-up]' : '[data-cover-down]')
        .forEach((button) => {
          button.onclick = () => {
            const next = [...(group.covers ?? [])],
              index = Number(button.dataset[attr]);
            [next[index], next[index + offset]] = [next[index + offset], next[index]];
            group.covers = next;
            render();
          };
        });
    }
  }
  return {
    render,
    pictureChanged() {
      if (getPicture()) getDraft().image ||= placeholder();
      else getDraft().image = null;
      render();
    },
  };
}
