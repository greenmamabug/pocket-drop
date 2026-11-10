// SPDX-License-Identifier: GPL-3.0-only
import { installPlayerUpdateUI } from './player-update.js';
import { installCollectionAppearance, collectionStackHTML } from './collection-appearance.js';
import {
  COLLECTION_LOOKS,
  collectionLook,
  collectionAppearance,
  withCollectionMembers,
} from '../app/collection-model.mjs';
const panels = `
<dialog id="audio-editor" class="audio-editor"><div class="editor-heading"><div><span class="eyebrow">AUDIO DETAILS</span><h3>Edit audio</h3></div><button class="text-button" id="editor-close">Close</button></div><p id="editor-notice" class="notice" hidden></p><div class="editor-summary"><div><div class="cover-crop-preview" id="cover-crop-preview"><img id="editor-cover" alt="Cover preview"></div><button class="text-button" id="change-cover">Change cover…</button></div><div class="editor-fields"><label>Title<input id="editor-title" maxlength="200"></label><div class="cover-controls"><label>Cover framing<select id="cover-mode"><option value="fit">Fit whole image</option><option value="fill">Fill card shape</option></select></label><label>Vertical position<input id="cover-position" type="range" min="0" max="100" value="50"></label></div><p class="hint">Edits apply to the version you sync. Your Inbox originals stay unchanged.</p></div></div><div class="track-tools"><label>Find a track<input id="track-search" type="search" placeholder="Search tracks…"></label><button class="text-button" id="import-track-icon">Import track icon…</button><button class="text-button" id="reset-track-edits">Reset to original details</button></div><p class="hint">Drag the grip or use ↑ and ↓ to reorder. Assign icons using each track’s icon menu. Delete excludes a track from this version; Restore brings it back.</p><div id="track-list" class="track-list"></div><div class="audio-preview"><span id="preview-track-name">Choose Play on a track to preview it.</span><audio id="track-player" controls preload="none"></audio><span id="preview-error" class="hint" hidden></span></div><div class="editor-footer"><button class="text-button danger" id="trash-original-tracks" hidden>Move excluded originals to Trash…</button><span id="editor-save-status" role="status"></span><button class="button" id="editor-save-only">Save</button><button class="button primary" id="editor-save">Save and close</button></div></dialog>
<dialog id="collection-dialog" class="studio-dialog collection-editor"><h3 id="collection-dialog-title">Collection</h3><label>Name<input id="collection-name" maxlength="40"></label><div class="collection-design"><div class="collection-live-preview"><span id="collection-card-preview"></span><span class="hint">Pocket preview</span></div><div class="collection-design-controls"><label>Look on Pocket<select id="collection-look"><option value="icon">Icon</option><option value="image">Picture</option><option value="covers">Chosen covers</option><option value="recent">Recent covers</option></select></label><div class="collection-picture-controls"><img id="collection-picture-preview" class="collection-picture" alt="Collection picture" hidden><button class="button" id="collection-picture-change">Change picture…</button><button class="text-button" id="collection-picture-clear">Clear picture</button></div><label class="collection-picture-toggle" id="collection-use-picture-row" hidden><input type="checkbox" id="collection-use-picture">Include collection picture on top</label></div></div><p class="hint" id="collection-look-hint"></p><div id="collection-cover-choices" class="collection-cover-choices" hidden></div><label>Find audio<input id="collection-search" type="search" placeholder="Search titles…"></label><p class="hint">Choose members, then drag selected items or use ↑ and ↓ to arrange their order on Pocket. Choosing an item from another collection moves it here.</p><div id="collection-members" class="collection-members"></div><div class="dialog-actions"><button class="button" id="collection-cancel">Cancel</button><button class="button primary" id="collection-save">Save collection</button></div></dialog>
<dialog id="prepare-dialog" class="studio-dialog"><h3>Prepare audio</h3><p>Convert and cache audio on your Mac before connecting Pocket. You can keep using the app and eject Pocket while preparation runs.</p><div id="prepare-items" class="prepare-items"></div><div class="dialog-actions"><button class="button" id="prepare-cancel">Cancel</button><button class="button primary" id="prepare-start">Prepare selected audio</button></div></dialog>
<dialog id="duplicates-dialog" class="studio-dialog"><h3>Compare matching imports</h3><p>Compare audio bytes to distinguish identical files from different editions. Choosing a preferred import hides the others; all originals stay in your Inbox.</p><div id="duplicate-groups"></div><div id="duplicate-results" role="status"></div><div class="dialog-actions"><button class="button" id="duplicates-close">Close</button></div></dialog>
<dialog id="problem-dialog" class="studio-dialog"><h3 id="problem-title"></h3><p id="problem-action"></p><ul id="problem-files"></ul><details><summary>Technical details</summary><pre id="problem-details"></pre></details><div class="dialog-actions"><button class="button" id="problem-close">Close</button></div></dialog>`;
export function installStudioUI({ api, esc, bytes, toast, getState, renderBooks }) {
  document.body.insertAdjacentHTML('beforeend', panels);
  document.querySelector('.collection-tools').append(document.querySelector('.library-actions'));
  const $ = (id) => document.getElementById(id),
    request = (method, ...args) => api.invoke(method, ...args);
  const guarded =
    (fn) =>
    async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        toast(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
      }
    };
  const playerUpdates = installPlayerUpdateUI({ api, guarded, getState });
  let documentData = null,
    dirty = false,
    opening = false,
    openingKey = null,
    saving = false,
    metricsTimer = null,
    groupDraft = null,
    pictureDraft = null,
    pictureChanged = false,
    draggedTrack = null,
    draggedGroup = null,
    draggedMember = null,
    update = null;
  const move = (list, from, to) => {
    if (from < 0 || to < 0 || to >= list.length) return;
    list.splice(to, 0, list.splice(from, 1)[0]);
  };
  const markDirty = () => {
    dirty = true;
    $('editor-save-status').textContent = 'Unsaved changes';
  };
  const duration = (ms) => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    return seconds >= 3600
      ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
      : seconds >= 60
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${seconds}s`;
  };
  function showProblem(problem) {
    $('problem-title').textContent = problem?.summary || 'This item needs attention';
    $('problem-action').textContent = problem?.action || 'Review the details and try again.';
    $('problem-files').innerHTML = (problem?.files ?? []).map((f) => `<li>${esc(f)}</li>`).join('');
    $('problem-details').textContent = problem?.details || 'No further details supplied.';
    $('problem-dialog').showModal();
  }
  $('problem-close').onclick = () => $('problem-dialog').close();
  function coverPreview() {
    const image = $('editor-cover');
    image.hidden = !documentData?.cover;
    if (documentData?.cover) image.src = documentData.cover;
    image.style.objectFit = $('cover-mode').value === 'fill' ? 'cover' : 'contain';
    image.style.objectPosition = `50% ${$('cover-position').value}%`;
  }
  async function closeEditor(force = false) {
    if (saving) {
      toast('Wait for your changes to finish saving.');
      return;
    }
    if (!force && dirty && !window.confirm('Discard unsaved audio edits?')) return;
    clearTimeout(metricsTimer);
    const id = documentData?.id;
    $('track-player').pause();
    $('track-player').removeAttribute('src');
    $('track-player').load();
    $('audio-editor').close();
    documentData = null;
    dirty = false;
    if (id) await request('closeEditor', id);
  }
  async function openEditor(key) {
    if (opening) return;
    opening = true;
    openingKey = key;
    renderBooks();
    try {
      const trigger = document.querySelector(`[data-edit="${CSS.escape(key)}"]`);
      if (trigger) {
        trigger.classList.add('opening');
        trigger.setAttribute('aria-busy', 'true');
        trigger.title = 'Opening audio details…';
      }
      documentData = await request('openEditor', key);
      if (!documentData) return;
      dirty = false;
      $('editor-title').value = documentData.title;
      $('cover-mode').value = documentData.coverMode;
      $('cover-position').value = documentData.coverPosition;
      $('track-search').value = '';
      $('editor-save-status').textContent = '';
      $('editor-notice').hidden = !documentData.notice;
      $('editor-notice').textContent = documentData.notice || '';
      $('preview-error').hidden = true;
      $('preview-track-name').textContent = 'Choose Play on a track to preview it.';
      coverPreview();
      renderTracks();
      $('audio-editor').showModal();
      void updateTrackMetrics(documentData.id);
    } finally {
      opening = false;
      openingKey = null;
      renderBooks();
      document.querySelectorAll('.audio-open.opening').forEach((e) => {
        e.classList.remove('opening');
        e.removeAttribute('aria-busy');
        e.title = 'Edit tracks, title, and artwork';
      });
    }
  }
  async function updateTrackMetrics(id) {
    clearTimeout(metricsTimer);
    if (documentData?.id !== id) return;
    try {
      const result = await request('editorMetrics', id);
      if (documentData?.id !== id || !result?.tracks) return;
      for (const metric of result.tracks) {
        const track = documentData.tracks.find((t) => t.key === metric.key);
        if (!track) continue;
        track.size = metric.size;
        track.durationMs = metric.durationMs;
        track.durationUnavailable =
          metric.unavailable || (!result.running && !Number.isFinite(metric.durationMs));
        const node = $('track-list').querySelector(
          `[data-track-metrics="${CSS.escape(track.key)}"]`,
        );
        if (node) {
          node.textContent =
            (Number.isFinite(track.durationMs)
              ? duration(track.durationMs)
              : track.durationUnavailable
                ? 'Length unavailable'
                : 'Length…') +
            ' · ' +
            bytes(track.size);
          node.title = metric.error ?? result.error ?? 'Track length · original file size';
        }
      }
      if (result.running) metricsTimer = setTimeout(() => void updateTrackMetrics(id), 500);
    } catch {
      if (documentData?.id === id) {
        for (const node of $('track-list').querySelectorAll('[data-track-metrics]'))
          if (node.textContent.startsWith('Length…'))
            node.textContent = node.textContent.replace('Length…', 'Length unavailable');
      }
    }
  }
  function renderTracks() {
    if (!documentData) return;
    const query = $('track-search').value.trim().toLowerCase(),
      icons = documentData.icons;
    $('track-list').innerHTML = documentData.tracks
      .map((track, index) => ({ track, index }))
      .filter(
        ({ track }) =>
          !query || [track.title, track.filename].some((t) => t?.toLowerCase().includes(query)),
      )
      .map(({ track, index }) => {
        const chosen = icons.find((i) => i.key === track.iconKey);
        return `<div class="track-edit-row ${track.excluded ? 'excluded' : ''}" data-track-row="${esc(track.key)}"><span class="track-grip" draggable="${!query}" data-track-grip="${esc(track.key)}" title="${query ? 'Clear track search to drag tracks' : 'Drag to reorder'}" aria-label="Drag ${esc(track.title)}">⠿</span><span class="track-position">${index + 1}</span><div class="track-name"><input data-track-title="${esc(track.key)}" value="${esc(track.title)}" maxlength="200" aria-label="Track ${index + 1} title"><small>${esc(track.filename)}</small><small class="track-metrics" data-track-metrics="${esc(track.key)}">${Number.isFinite(track.durationMs) ? duration(track.durationMs) : track.durationUnavailable ? 'Length unavailable' : 'Length…'} · ${bytes(track.size)}</small></div><img class="track-icon" src="${esc(chosen?.url ?? '')}" alt="" ${chosen ? '' : 'hidden'}><select data-track-icon="${esc(track.key)}" aria-label="Icon for track ${index + 1}"><option value="">Default icon</option>${icons.map((i) => `<option value="${esc(i.key)}" ${track.iconKey === i.key ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select><div class="track-reorder"><button class="text-button" data-track-up="${esc(track.key)}" aria-label="Move track ${index + 1} up" ${index === 0 ? 'disabled' : ''}>↑</button><button class="text-button" data-track-down="${esc(track.key)}" aria-label="Move track ${index + 1} down" ${index === documentData.tracks.length - 1 ? 'disabled' : ''}>↓</button></div><button class="text-button" data-track-play="${esc(track.key)}">Play</button><button class="text-button ${track.excluded ? '' : 'danger'}" data-track-delete="${esc(track.key)}">${track.excluded ? 'Restore' : 'Delete'}</button></div>`;
      })
      .join('');
    const find = (key) => documentData.tracks.find((t) => t.key === key),
      index = (key) => documentData.tracks.findIndex((t) => t.key === key);
    $('track-list')
      .querySelectorAll('[data-track-title]')
      .forEach(
        (e) =>
          (e.oninput = () => {
            find(e.dataset.trackTitle).title = e.value;
            markDirty();
          }),
      );
    $('track-list')
      .querySelectorAll('[data-track-icon]')
      .forEach(
        (e) =>
          (e.onchange = () => {
            find(e.dataset.trackIcon).iconKey = e.value || null;
            markDirty();
            renderTracks();
          }),
      );
    for (const [attribute, offset] of [
      ['trackUp', -1],
      ['trackDown', 1],
    ])
      $('track-list')
        .querySelectorAll(attribute === 'trackUp' ? '[data-track-up]' : '[data-track-down]')
        .forEach(
          (e) =>
            (e.onclick = () => {
              const from = index(e.dataset[attribute]);
              move(documentData.tracks, from, from + offset);
              markDirty();
              renderTracks();
            }),
        );
    $('track-list')
      .querySelectorAll('[data-track-delete]')
      .forEach(
        (e) =>
          (e.onclick = () => {
            const track = find(e.dataset.trackDelete);
            track.excluded = !track.excluded;
            markDirty();
            renderTracks();
          }),
      );
    $('track-list')
      .querySelectorAll('[data-track-play]')
      .forEach(
        (e) =>
          (e.onclick = guarded(async () => {
            const track = find(e.dataset.trackPlay);
            $('preview-track-name').textContent = track.title;
            $('preview-error').hidden = true;
            $('track-player').src = track.url;
            await $('track-player').play();
          })),
      );
    $('track-list')
      .querySelectorAll('[data-track-grip]')
      .forEach(
        (e) =>
          (e.ondragstart = (event) => {
            draggedTrack = e.dataset.trackGrip;
            event.dataTransfer.setData('text/pocket-track', draggedTrack);
            event.dataTransfer.effectAllowed = 'move';
          }),
      );
    $('track-list')
      .querySelectorAll('[data-track-row]')
      .forEach((e) => {
        e.ondragover = (event) => {
          if (draggedTrack && !query) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }
        };
        e.ondrop = (event) => {
          if (!draggedTrack || query) return;
          event.preventDefault();
          move(documentData.tracks, index(draggedTrack), index(e.dataset.trackRow));
          draggedTrack = null;
          markDirty();
          renderTracks();
        };
        e.ondragend = () => (draggedTrack = null);
      });
    $('trash-original-tracks').hidden =
      !documentData.canTrashOriginals || !documentData.tracks.some((t) => t.excluded);
  }
  $('track-player').onerror = () => {
    $('preview-error').hidden = false;
    $('preview-error').textContent =
      'This original cannot be previewed by the audio player. It may still be convertible when you prepare it.';
  };
  $('editor-close').onclick = guarded(() => closeEditor());
  $('audio-editor').addEventListener('cancel', (event) => {
    event.preventDefault();
    void guarded(() => closeEditor())();
  });
  for (const id of ['editor-title']) $(id).oninput = markDirty;
  for (const id of ['cover-mode', 'cover-position'])
    $(id).oninput = () => {
      markDirty();
      coverPreview();
    };
  $('track-search').oninput = renderTracks;
  $('change-cover').onclick = guarded(async () => {
    const image = await request('pickArtwork', documentData.id, 'cover');
    if (image) {
      documentData.coverRef = image.key;
      documentData.cover = image.url;
      markDirty();
      coverPreview();
    }
  });
  $('import-track-icon').onclick = guarded(async () => {
    const image = await request('pickArtwork', documentData.id, 'icon');
    if (image) {
      documentData.icons.push(image);
      renderTracks();
      toast('The imported icon is now available in every track’s icon menu.');
    }
  });
  $('reset-track-edits').onclick = () => {
    if (!window.confirm('Reset names, order, track exclusions, and cover to the original details?'))
      return;
    const defaults = documentData.defaults,
      previous = new Map(documentData.tracks.map((t) => [t.key, t]));
    documentData.tracks = defaults.tracks.map((t) => ({ ...previous.get(t.key), ...t }));
    documentData.coverRef = null;
    documentData.cover = defaults.cover;
    $('editor-title').value = defaults.title;
    $('cover-mode').value = 'fit';
    $('cover-position').value = 50;
    markDirty();
    renderTracks();
    coverPreview();
  };
  async function saveEditor() {
    if (saving) throw new Error('Changes are already being saved.');
    saving = true;
    const controls = [...$('audio-editor').querySelectorAll('input,select,button')].map((e) => ({
      e,
      disabled: e.disabled,
    }));
    controls.forEach(({ e }) => (e.disabled = true));
    const input = {
      title: $('editor-title').value,
      tags: documentData.tags ?? [],
      coverRef: documentData.coverRef,
      coverMode: $('cover-mode').value,
      coverPosition: Number($('cover-position').value),
      tracks: documentData.tracks,
    };
    try {
      await request('saveEditor', documentData.id, input);
      dirty = false;
      $('editor-save-status').textContent = getState().rows.find(
        (r) => r.key === documentData.rowKey,
      )?.onDevice
        ? 'Saved. Use Sync changes in All Audio to update Pocket.'
        : 'Saved';
    } finally {
      saving = false;
      controls.forEach(({ e, disabled }) => (e.disabled = disabled));
    }
  }
  $('editor-save-only').onclick = guarded(saveEditor);
  $('editor-save').onclick = guarded(async () => {
    await saveEditor();
    await closeEditor(true);
  });
  $('trash-original-tracks').onclick = guarded(async () => {
    $('trash-original-tracks').disabled = true;
    try {
      await saveEditor();
      const result = await request('trashExcluded', documentData.id);
      if (result?.trashed) {
        await closeEditor(true);
        toast(`${result.trashed} original file(s) moved to Trash.`);
      } else if (result?.cancelled) toast('Original files kept.');
    } finally {
      $('trash-original-tracks').disabled = false;
    }
  });
  const appearance = installCollectionAppearance({
    getDraft: () => groupDraft,
    getPicture: () => pictureDraft,
    getState,
    esc,
  });
  const currentGroups = () => getState().collections ?? [];
  async function saveGroups(groups, changes = {}) {
    const saved = await request('saveCollections', groups, changes);
    renderCollections({ ...getState(), collections: saved ?? groups });
  }
  const centerGlyph = () => '<span class="collection-picture placeholder-picture">♫</span>';
  function picturePreview() {
    const image = $('collection-picture-preview');
    image.hidden = !pictureDraft?.thumbnail;
    if (pictureDraft?.thumbnail) image.src = pictureDraft.thumbnail;
    $('collection-picture-clear').hidden = !pictureDraft;
  }
  function renderCollections(state) {
    const groups = state.collections ?? [],
      deviceGroups = state.device.check?.groups?.groups ?? [];
    const synced = (group) =>
      deviceGroups.some(
        (g) =>
          JSON.stringify(collectionAppearance(g)) === JSON.stringify(collectionAppearance(group)),
      );
    $('collection-sync-status').textContent =
      state.operation === 'collections-read'
        ? 'Reading collections and pictures from Pocket…'
        : !state.device.connected
          ? 'Saved on this computer. Connect Pocket to sync.'
          : state.collectionSyncNeeded || groups.some((g) => !synced(g))
            ? 'Collection changes ready to sync.'
            : groups.length
              ? 'Collections match Pocket. Eject Pocket to load the changes.'
              : '';
    $('collection-cards').innerHTML = groups.length
      ? groups
          .map(
            (group, index) =>
              `<article class="collection-card" data-group-card="${esc(group.id)}"><span class="group-grip" draggable="true" data-group-grip="${esc(group.id)}" aria-label="Drag ${esc(group.title)}">⠿</span>${state.collectionPictures?.[group.id]?.thumbnail ? `<img class="collection-picture" src="${esc(state.collectionPictures[group.id].thumbnail)}" alt="${esc(group.title)}">` : centerGlyph()}<div class="collection-heading"><h3>${esc(group.title)}</h3><p>${group.playlists.length} audio item${group.playlists.length === 1 ? '' : 's'} · ${group.playlists.filter((id) => state.rows.some((r) => r.id === id && r.onDevice)).length} on Pocket</p></div><div class="collection-art">${collectionStackHTML(group, state, state.collectionPictures?.[group.id], esc)}<span>${esc(COLLECTION_LOOKS[collectionLook(group)])}</span></div><p class="collection-state hint">${!group.playlists.length ? 'Empty collections are hidden on the player.' : !state.device.connected ? 'Saved on this computer' : synced(group) ? 'Collection arrangement saved on Pocket' : 'Collection not yet synced to this Pocket'}</p><div class="collection-controls"><button class="text-button" data-group-up="${esc(group.id)}" aria-label="Move collection up" ${index === 0 || state.busy ? 'disabled' : ''}>↑</button><button class="text-button" data-group-down="${esc(group.id)}" aria-label="Move collection down" ${index === groups.length - 1 || state.busy ? 'disabled' : ''}>↓</button><button class="button" data-group-edit="${esc(group.id)}">Edit</button><button class="text-button danger" data-group-delete="${esc(group.id)}" ${state.busy ? 'disabled' : ''}>Delete</button></div></article>`,
          )
          .join('')
      : '<div class="empty"><h3>No collections yet</h3><p>Create a collection for a series, person, mood, or type of audio.</p></div>';
    $('collection-cards')
      .querySelectorAll('[data-group-edit]')
      .forEach((e) => (e.onclick = () => editCollection(e.dataset.groupEdit)));
    $('collection-cards')
      .querySelectorAll('[data-group-delete]')
      .forEach(
        (e) =>
          (e.onclick = guarded(async () => {
            if (
              window.confirm(
                'Delete this collection? Its audio stays in your library and on Pocket. Sync Collections to update Pocket.',
              )
            )
              await saveGroups(groups.filter((g) => g.id !== e.dataset.groupDelete));
          })),
      );
    for (const [attr, offset] of [
      ['groupUp', -1],
      ['groupDown', 1],
    ])
      $('collection-cards')
        .querySelectorAll(attr === 'groupUp' ? '[data-group-up]' : '[data-group-down]')
        .forEach(
          (e) =>
            (e.onclick = guarded(async () => {
              const list = structuredClone(groups),
                from = list.findIndex((g) => g.id === e.dataset[attr]);
              move(list, from, from + offset);
              await saveGroups(list);
            })),
        );
    $('collection-cards')
      .querySelectorAll('[data-group-grip]')
      .forEach(
        (e) =>
          (e.ondragstart = (event) => {
            draggedGroup = e.dataset.groupGrip;
            event.dataTransfer.setData('text/pocket-group', draggedGroup);
          }),
      );
    $('collection-cards')
      .querySelectorAll('[data-group-card]')
      .forEach((e) => {
        e.ondragover = (event) => {
          if (draggedGroup) event.preventDefault();
        };
        e.ondrop = guarded(async (event) => {
          if (!draggedGroup) return;
          event.preventDefault();
          const list = structuredClone(groups);
          move(
            list,
            list.findIndex((g) => g.id === draggedGroup),
            list.findIndex((g) => g.id === e.dataset.groupCard),
          );
          draggedGroup = null;
          await saveGroups(list);
        });
        e.ondragend = () => (draggedGroup = null);
      });
    $('apply-collections').disabled =
      state.busy || state.preparation?.running || !state.device.connected;
    $('import-collections').disabled = state.busy || !state.device.connected;
    $('new-collection').disabled = state.busy || groups.length >= 30;
  }
  function editCollection(id) {
    const group = currentGroups().find((g) => g.id === id);
    groupDraft = structuredClone(
      group ?? {
        id: 'pd-' + crypto.randomUUID().slice(0, 20),
        title: '',
        icon: null,
        display: 'recent',
        playlists: [],
      },
    );
    pictureDraft = getState().collectionPictures?.[groupDraft.id] ?? null;
    pictureChanged = false;
    picturePreview();
    appearance.render();
    $('collection-name').value = groupDraft.title;
    $('collection-search').value = '';
    $('collection-dialog-title').textContent = group ? 'Edit collection' : 'New collection';
    renderMembers();
    $('collection-dialog').showModal();
  }
  function renderMembers() {
    appearance.render();
    const state = getState(),
      members = groupDraft.playlists,
      query = $('collection-search').value.toLowerCase(),
      unique = new Map();
    for (const r of state.rows.filter((r) => !r.hidden))
      if (r.id && !unique.has(r.id)) unique.set(r.id, r);
    for (const id of members)
      if (!unique.has(id)) unique.set(id, { id, title: id + ' (not currently in the library)' });
    const rows = [
      ...members.map((id) => unique.get(id)),
      ...[...unique.values()]
        .filter((r) => !members.includes(r.id))
        .sort((a, b) => a.title.localeCompare(b.title)),
    ];
    $('collection-members').innerHTML = rows
      .filter((r) => r.title.toLowerCase().includes(query))
      .map((row) => {
        const index = members.indexOf(row.id),
          other = currentGroups().find(
            (g) => g.id !== groupDraft.id && g.playlists.includes(row.id),
          );
        return `<div class="collection-member" data-member-row="${esc(row.id)}"><span draggable="${index >= 0 && !query}" data-member-grip="${esc(row.id)}" class="group-grip">${index >= 0 ? '⠿' : ''}</span><label><input type="checkbox" data-member="${esc(row.id)}" ${index >= 0 ? 'checked' : ''}><span>${esc(row.title)}${other ? `<small>Currently in ${esc(other.title)}</small>` : ''}</span></label>${index >= 0 ? `<button class="text-button" data-member-up="${esc(row.id)}" aria-label="Move audio up" ${index === 0 ? 'disabled' : ''}>↑</button><button class="text-button" data-member-down="${esc(row.id)}" aria-label="Move audio down" ${index === members.length - 1 ? 'disabled' : ''}>↓</button>` : ''}</div>`;
      })
      .join('');
    $('collection-members')
      .querySelectorAll('[data-member]')
      .forEach(
        (e) =>
          (e.onchange = () => {
            groupDraft = withCollectionMembers(
              groupDraft,
              e.checked
                ? [...members, e.dataset.member]
                : members.filter((id) => id !== e.dataset.member),
            );
            if (
              e.checked &&
              groupDraft.display === 'covers' &&
              (groupDraft.covers?.length ?? 0) < 3 &&
              getState().rows.some((r) => r.id === e.dataset.member && r.cover)
            )
              groupDraft.covers = [...(groupDraft.covers ?? []), e.dataset.member];
            renderMembers();
          }),
      );
    for (const [attr, offset] of [
      ['memberUp', -1],
      ['memberDown', 1],
    ])
      $('collection-members')
        .querySelectorAll(attr === 'memberUp' ? '[data-member-up]' : '[data-member-down]')
        .forEach(
          (e) =>
            (e.onclick = () => {
              const from = members.indexOf(e.dataset[attr]);
              move(members, from, from + offset);
              renderMembers();
            }),
        );
    $('collection-members')
      .querySelectorAll('[data-member-grip]')
      .forEach(
        (e) =>
          (e.ondragstart = (event) => {
            draggedMember = e.dataset.memberGrip;
            event.dataTransfer.setData('text/pocket-member', draggedMember);
          }),
      );
    $('collection-members')
      .querySelectorAll('[data-member-row]')
      .forEach((e) => {
        e.ondragover = (event) => {
          if (draggedMember && members.includes(e.dataset.memberRow) && !query)
            event.preventDefault();
        };
        e.ondrop = (event) => {
          if (!draggedMember || query) return;
          event.preventDefault();
          move(members, members.indexOf(draggedMember), members.indexOf(e.dataset.memberRow));
          draggedMember = null;
          renderMembers();
        };
        e.ondragend = () => (draggedMember = null);
      });
  }
  $('new-collection').onclick = () => editCollection();
  $('collection-cancel').onclick = () => $('collection-dialog').close();
  $('collection-search').oninput = renderMembers;
  $('collection-save').onclick = guarded(async () => {
    if ($('collection-save').disabled) return;
    $('collection-save').disabled = true;
    try {
      groupDraft.title = $('collection-name').value;
      const picked = new Set(groupDraft.playlists),
        groups = currentGroups()
          .filter((g) => g.id !== groupDraft.id)
          .map((g) =>
            withCollectionMembers(
              g,
              g.playlists.filter((id) => !picked.has(id)),
            ),
          ),
        index = currentGroups().findIndex((g) => g.id === groupDraft.id);
      groups.splice(index < 0 ? groups.length : index, 0, groupDraft);
      if (pictureChanged)
        groupDraft.icon = pictureDraft ? 'groups/' + groupDraft.id + '.png' : null;
      await saveGroups(groups, pictureChanged ? { [groupDraft.id]: pictureDraft } : {});
      $('collection-dialog').close();
    } finally {
      $('collection-save').disabled = false;
    }
  });
  $('collection-picture-change').onclick = guarded(async () => {
    const picture = await request('pickCollectionPicture');
    if (picture) {
      pictureDraft = picture;
      pictureChanged = true;
      picturePreview();
      appearance.pictureChanged();
    }
  });
  $('collection-picture-clear').onclick = () => {
    pictureDraft = null;
    pictureChanged = true;
    picturePreview();
    appearance.pictureChanged();
  };
  $('apply-collections').onclick = guarded(() => request('applyCollections'));
  $('import-collections').onclick = guarded(() => request('importCollections'));
  $('prepare-audio').onclick = () => {
    const rows = getState().rows.filter(
      (r) =>
        r.local &&
        !r.hidden &&
        (r.needsConversion ?? (r.opusCount && !r.prepared)) &&
        !['error', 'downloading', 'checking'].includes(r.status),
    );
    $('prepare-items').innerHTML = rows.length
      ? rows
          .map(
            (r) =>
              `<label class="prepare-item"><input type="checkbox" data-prepare-item="${esc(r.key)}"><span>${esc(r.title)}<small>${r.prepared ? 'Prepared audio available' : r.oggCount ? 'Ogg conversion required' : r.opusCount ? 'Opus conversion required' : 'Check and prepare audio'}</small></span></label>`,
          )
          .join('')
      : '<p>Add audio to your Inbox first.</p>';
    $('prepare-dialog').showModal();
  };
  $('prepare-cancel').onclick = () => $('prepare-dialog').close();
  $('prepare-start').onclick = guarded(async () => {
    const keys = [...$('prepare-items').querySelectorAll('input:checked')].map(
      (e) => e.dataset.prepareItem,
    );
    await request('prepareAudio', keys);
    $('prepare-dialog').close();
  });
  $('cancel-preparation').onclick = guarded(() => request('cancelPreparation'));
  $('preparation-problem').onclick = () => showProblem(getState().preparation?.problem);
  $('undo-removal').onclick = guarded(() => request('undoRemoval'));
  $('compare-imports').onclick = () => {
    const matches = getState().duplicates?.groups ?? [];
    $('duplicate-groups').innerHTML = matches
      .map(
        (group, i) =>
          `<div class="duplicate-group"><strong>${esc(group.title)}</strong><span>${group.items.length} imports</span><button class="button" data-compare-group="${i}">Review</button></div>`,
      )
      .join('');
    $('duplicate-results').innerHTML = '';
    $('duplicate-groups')
      .querySelectorAll('[data-compare-group]')
      .forEach(
        (e) =>
          (e.onclick = () => {
            const group = matches[Number(e.dataset.compareGroup)],
              keys = group.items.map((item) => item.key);
            $('duplicate-results').innerHTML = group.items
              .map(
                (item) =>
                  `<div class="duplicate-result"><strong>${esc(item.source)}</strong><p>${esc(item.comparison)} · ${item.tracks} files</p><button class="button" data-prefer="${esc(item.key)}">Use this import</button></div>`,
              )
              .join('');
            $('duplicate-results')
              .querySelectorAll('[data-prefer]')
              .forEach(
                (b) =>
                  (b.onclick = guarded(async () => {
                    await request('preferImport', keys, b.dataset.prefer);
                    $('duplicates-dialog').close();
                    toast(
                      'Preferred import selected. Other originals are hidden and remain in the Inbox.',
                    );
                  })),
              );
          }),
      );
    $('duplicates-dialog').showModal();
  };
  $('duplicates-close').onclick = () => $('duplicates-dialog').close();
  $('completion-notifications').onchange = guarded((e) =>
    request('completionNotifications', e.target.checked),
  );
  $('save-update-source').onclick = guarded(() =>
    request('updateRepository', $('update-repository').value.trim()),
  );
  $('open-downloads').onclick = guarded(() => request('openDownloads'));
  $('download-update').onclick = guarded(() => request('downloadUpdate'));
  $('check-updates').onclick = guarded(async () => {
    $('check-updates').disabled = true;
    $('update-status').textContent = 'Checking for updates…';
    try {
      update = await request('checkUpdates');
      $('update-status').textContent =
        update.status === 'available'
          ? `Version ${update.version} is available. You have ${update.current}.`
          : update.status === 'current'
            ? `You have ${update.current}. No newer release was found.`
            : `Installed version: ${update.current}. ${update.message}`;
      $('update-notes').hidden = !update.notes;
      $('update-notes').textContent = update.notes || '';
      $('download-update').hidden = !update.url || update.status !== 'available';
    } finally {
      $('check-updates').disabled = false;
    }
  });
  function updatePreparationTime() {
    const state = getState(),
      working = state.busy && state.operation === 'sync',
      elapsedWork = working && state.operationStartedAt ? Date.now() - state.operationStartedAt : 0,
      deadline = state.progress?.conversionEtaAt;
    const estimate =
      working && elapsedWork > 10000 && deadline
        ? deadline > Date.now()
          ? duration(deadline - Date.now())
          : 'updating estimate…'
        : null;
    $('operation-timing').textContent = working
      ? `Elapsed ${duration(elapsedWork)}${estimate ? ' · estimated preparation remaining ' + estimate : ''}`
      : '';
    const p = state.preparation;
    if (!p) return;
    const elapsed = p.running ? Date.now() - p.startedAt : p.elapsedMs;
    const remaining =
      p.running && p.estimateAt
        ? Math.max(0, p.estimateAt - Date.now())
        : p.running && p.remainingMs !== null && p.remainingMs !== undefined
          ? Math.max(0, p.remainingMs - (Date.now() - p.startedAt - p.elapsedMs))
          : null;
    $('preparation-time').textContent =
      `Elapsed ${duration(elapsed ?? 0)}${remaining !== null && remaining > 0 ? ' · estimated remaining ' + duration(remaining) : p.running ? ' · estimating remaining time…' : ''}`;
  }
  setInterval(updatePreparationTime, 1000);
  function render(state) {
    playerUpdates.render(state);
    $('undo-removal').hidden = !state.undoAvailable;
    $('undo-removal').disabled = state.busy || !state.device.connected;
    $('prepare-audio').hidden = !state.rows.some(
      (r) => r.local && !r.hidden && (r.needsConversion ?? (r.opusCount && !r.prepared)),
    );
    $('prepare-audio').disabled = state.busy || state.preparation?.running;
    $('compare-imports').disabled = state.busy || state.preparation?.running;
    $('compare-imports').hidden = !state.duplicates?.groups?.length;
    $('duplicate-status').hidden = !state.duplicates?.checking;
    $('duplicate-status').textContent = 'Checking possible duplicates…';
    const p = state.preparation;
    $('preparation-status').hidden = !p;
    if (p) {
      $('preparation-title').textContent = p.phase;
      $('preparation-file').textContent = p.file
        ? `${p.file} · file ${p.fileIndex} of ${p.fileTotal}`
        : '';
      $('preparation-progress').value = p.percent ?? 0;
      $('cancel-preparation').hidden = !p.running;
      $('preparation-problem').hidden = !p.problem;
      updatePreparationTime();
    }
    $('completion-notifications').checked = !!state.settings?.completionNotifications;
    if (document.activeElement !== $('update-repository'))
      $('update-repository').value = state.settings?.updateRepository ?? '';
    if (!update) $('update-status').textContent = `Installed version: ${state.version ?? '—'}.`;
    $('hidden-imports').innerHTML =
      state.rows
        .filter((r) => r.hidden)
        .map(
          (r) =>
            `<div class="hidden-import"><span>${esc(r.title)}</span><button class="text-button" data-unhide="${esc(r.key)}">Restore</button></div>`,
        )
        .join('') || '<p class="hint">No hidden imports.</p>';
    $('hidden-imports')
      .querySelectorAll('[data-unhide]')
      .forEach((e) => (e.onclick = guarded(() => request('restoreHidden', e.dataset.unhide))));
    renderCollections(state);
  }
  return {
    openEditor: guarded(openEditor),
    get openingKey() {
      return openingKey;
    },
    showProblem,
    render,
  };
}
