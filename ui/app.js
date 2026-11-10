import { installStudioUI } from './studio.js';
import { storagePreview } from './storage-preview.mjs';
const paths = {
  edit: 'M4 16v4h4L20 8l-4-4Z M14 6l4 4',
  eject: 'M4 17h16v3H4Z M12 4l8 10H4Z',
  remove: 'M10 4H4v16h6 M8 12h13 M16 7l5 5-5 5',
  book: 'M3 4.5c4-1.5 7-.5 9 1.5 2-2 5-3 9-1.5v15c-4-1.5-7-.5-9 1.5-2-2-5-3-9-1.5Zm9 1.5v15',
  clock: 'M12 7v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  drive: 'M4 4h16v16H4z M7 15h10 M16 18h1',
  settings:
    'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  help: 'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3 M12 17h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  folder: 'M3 7V5h6l2 3h10v12H3V7Z M3 9h18',
  player:
    'M6 1.5h12a2 2 0 0 1 2 2v17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-17a2 2 0 0 1 2-2Z M7 4h10v7H7Z M16 16.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M13.2 16.5a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0',
  chevron: 'm9 6 6 6-6 6',
  refresh:
    'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 M8 16H3v5',
  plus: 'M12 4v16 M4 12h16',
  'folder-plus': 'M3 7V5h6l2 3h10v12H3V7Z M12 11v6 M9 14h6',
  search: 'M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  shield: 'M12 2 3 5v6c0 5 4 8 9 11 5-3 9-6 9-11V5z M8 12l3 3 5-6',
  arrow: 'M4 12h16 M14 6l6 6-6 6',
  check: 'm5 12 4 4L19 6',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',
  alert: 'M12 8v5 M12 17h.01 M12 2 1 21h22Z',
};
const playerIcon =
  '<svg viewBox="0 0 48 72" aria-hidden="true" class="clickwheel-player"><rect x="2" y="2" width="44" height="68" rx="7" fill="#655f6c" stroke="#4c4655"/><rect x="9" y="9" width="30" height="25" rx="2" fill="#edf0e5" stroke="#46414e"/><circle cx="24" cy="51" r="12" fill="#f7f5f9" stroke="#d3ccd9"/><circle cx="24" cy="51" r="4" fill="#b5acbf" stroke="none"/></svg>';
const icon = (n) =>
  n === 'player'
    ? playerIcon
    : `<svg viewBox="${n === 'refresh' ? '-1 -1 26 26' : '0 0 24 24'}" aria-hidden="true"><path d="${paths[n] ?? paths.book}"/></svg>`;
document.querySelectorAll('[data-icon]').forEach((e) => (e.innerHTML = icon(e.dataset.icon)));
const $ = (id) => document.getElementById(id),
  esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
let state = { rows: [], device: { connected: false }, logs: [], settings: { autoRefresh: true } },
  selected = new Set(),
  removeSelection = new Set(),
  seen = new Map(),
  filter = 'all',
  page = 'books',
  toastTimer,
  dismissedResult = null,
  dragDepth = 0;
const sorts = {
  all: { key: null, dir: 1 },
  device: { key: null, dir: 1 },
  missing: { key: null, dir: 1 },
};
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const api = window.pocket;
let studio;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 9000);
}
async function call(method, ...args) {
  try {
    return await api.invoke(method, ...args);
  } catch (error) {
    toast(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
  }
}
const bytes = (n) =>
  n == null
    ? '—'
    : n >= 1e9
      ? (n / 1e9).toFixed(1) + ' GB'
      : n >= 1e6
        ? Math.round(n / 1e6) + ' MB'
        : n >= 1e3
          ? Math.round(n / 1e3) + ' KB'
          : n + ' B';
const audioLength = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const minutes = Math.floor(ms / 60000),
    hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : minutes ? `${minutes}m` : '<1m';
};
const labels = {
  unverified: ['check', 'On Pocket'],
  current: ['check', 'On Pocket'],
  ready: ['plus', 'Not on Pocket'],
  update: ['check', 'On Pocket · update available'],
  disconnected: ['player', 'Pocket disconnected'],
  'device-only': ['check', 'On Pocket · no local copy'],
  checking: ['clock', 'Checking audio item…'],
  downloading: ['clock', 'Still downloading…'],
  error: ['alert', 'Needs attention'],
};
function showPage(next) {
  page = next;
  document.querySelectorAll('.page').forEach((e) => e.classList.toggle('active', e.id === next));
  document
    .querySelectorAll('.nav')
    .forEach((e) => e.classList.toggle('active', e.dataset.page === next));
  const titles = {
    books: ['', 'Audio Library', ''],
    collections: ['', 'Collections', 'Arrange your audio for Pocket'],
    activity: ['', 'Recent Activity', 'Your recent imports, transfers, and updates'],
    storage: ['', 'Storage', ''],
    settings: ['', 'Settings', ''],
    help: ['', 'Getting started', ''],
  };
  const t = titles[next];
  $('eyebrow').textContent = t[0];
  $('heading').textContent = t[1];
  $('subtitle').textContent = t[2];
  $('search').closest('.search').hidden = next !== 'books';
  $('refresh').hidden = next !== 'books';
}
document
  .querySelectorAll('[data-page]')
  .forEach((e) => (e.onclick = () => showPage(e.dataset.page)));
document.querySelectorAll('[data-filter]').forEach(
  (e) =>
    (e.onclick = () => {
      filter = e.dataset.filter;
      render();
    }),
);
$('search').oninput = () => renderBooks();
document.querySelectorAll('[data-sort]').forEach(
  (e) =>
    (e.onclick = () => {
      const current = sorts[filter];
      sorts[filter] = {
        key: e.dataset.sort,
        dir: current.key === e.dataset.sort ? -current.dir : 1,
      };
      renderBooks();
    }),
);
const actionable = (r) =>
  r.local && (!r.onDevice || r.edited) && ['ready', 'update', 'unverified'].includes(r.status);
const selectable = (r) => r.onDevice || actionable(r);
function visibleRows() {
  const q = $('search').value.toLowerCase().trim(),
    sort = sorts[filter];
  const rows = state.rows.filter(
    (r) =>
      !r.hidden &&
      (filter !== 'device' || r.onDevice) &&
      (filter !== 'missing' || (state.device.connected && r.local && !r.onDevice)) &&
      (!q ||
        [r.title, ...(r.searchTracks ?? []), ...(r.tags ?? [])].some((t) =>
          t.toLowerCase().includes(q),
        )),
  );
  if (sort.key)
    rows.sort((a, b) => {
      let value;
      if (sort.key === 'size') value = (a.size ?? 0) - (b.size ?? 0);
      else if (sort.key === 'length') {
        if (a.durationMs == null || b.durationMs == null)
          return a.durationMs == null
            ? b.durationMs == null
              ? collator.compare(a.title, b.title)
              : 1
            : -1;
        value = a.durationMs - b.durationMs;
      } else if (sort.key === 'title') value = collator.compare(a.title, b.title);
      else if (filter === 'device')
        value = Number(removeSelection.has(a.key)) - Number(removeSelection.has(b.key));
      else
        value = collator.compare(
          labels[a.status]?.[1] ?? a.status,
          labels[b.status]?.[1] ?? b.status,
        );
      return sort.dir * (value || collator.compare(a.title, b.title));
    });
  return rows;
}
function renderBooks() {
  const rows = visibleRows(),
    locked = state.busy || state.scanning;
  const scope = state.rows.filter((r) => !r.hidden);
  const offlineFilter = filter === 'missing' && !state.device.connected;
  $('empty-open').hidden = offlineFilter;
  document.querySelector('.empty-foot').hidden = offlineFilter;
  $('rows').innerHTML = rows
    .map((r) => {
      const label = labels[r.status] ?? labels.error;
      let status;
      if (filter === 'device' || (r.onDevice && removeSelection.has(r.key)))
        status = `<button class="remove-choice ${removeSelection.has(r.key) ? 'chosen' : ''}" data-remove-select="${esc(r.key)}" aria-pressed="${removeSelection.has(r.key)}" title="${r.local ? 'Select for removal from Pocket. Your original files stay in your Inbox folder.' : 'Select for removal from Pocket. No original is in your Inbox folder.'}" ${locked ? 'disabled' : ''}>${icon('remove')}<span>${removeSelection.has(r.key) ? 'Queued for removal' : 'Select for removal'}</span></button>`;
      else if (r.onDevice && r.edited)
        status = `<button class="status sync-choice ${selected.has(r.key) ? 'queued' : ''}" data-queue="${esc(r.key)}" ${locked ? 'disabled' : ''}>${icon('edit')}${selected.has(r.key) ? 'Added to sync queue' : 'Sync changes'}</button>`;
      else if (r.onDevice)
        status = `<button class="status current pocket-toggle" data-remove-select="${esc(r.key)}" aria-pressed="false" title="${r.local ? 'Queue for removal from Pocket. Your original files stay in your Inbox folder.' : 'Queue for removal from Pocket. No original is in your Inbox folder.'}" ${locked ? 'disabled' : ''}>${icon('check')}On Pocket</button>`;
      else if (actionable(r))
        status = `<button class="status sync-choice ${selected.has(r.key) ? 'queued' : ''}" data-queue="${esc(r.key)}" aria-pressed="${selected.has(r.key)}" title="${selected.has(r.key) ? 'Remove from sync queue' : 'Add to sync queue'}" ${locked ? 'disabled' : ''}>${icon(selected.has(r.key) ? 'check' : 'plus')}${selected.has(r.key) ? 'Added to sync queue' : 'Not on Pocket'}</button>`;
      else
        status = `<span class="status ${esc(r.status)}" ${r.status === 'error' ? `role="button" tabindex="0" data-error="${esc(r.key)}"` : ''} title="${esc(r.message ?? r.notes?.join(' ') ?? label[1])}">${icon(label[0])}${label[1]}</span>`;
      return `<tr class="${(filter === 'device' ? removeSelection : selected).has(r.key) ? 'selected' : ''}"><td>${status}</td><td><div class="book-cell">${r.cover ? `<img class="cover" src="${esc(r.cover)}" alt="Cover of ${esc(r.title)}">` : `<div class="cover placeholder" aria-label="No cover artwork">${icon('book')}</div>`}<div class="book-text"><button class="book-title audio-open ${studio?.openingKey === r.key ? 'opening' : ''}" aria-busy="${studio?.openingKey === r.key}" data-edit="${esc(r.key)}" title="${r.local ? 'Edit tracks, title, and artwork' : 'Add the original to your Inbox to edit'}" ${!r.local ? 'disabled' : ''}><span>${esc(r.title)}</span>${r.local ? `<span class="edit-title-icon" aria-hidden="true">${icon(studio?.openingKey === r.key ? 'refresh' : 'edit')}</span>` : ''}</button><div class="book-meta">${r.tracks ? r.tracks + ' files' : 'Audio files'}${r.opusCount ? (state.progress?.conversionKey === r.key ? (r.oggCount ? ' · Converting Ogg to AAC' : ' · Converting Opus to AAC') : r.oggCount ? ' · Ogg audio' : ' · Opus audio') : ''}${!r.local ? ' · On Pocket only' : ''}${r.duplicates ? ' · ' + r.duplicates + ' matching originals' : ''}</div></div></div></td><td class="size">${bytes(r.size)}</td><td class="length" title="${r.durationMs == null ? 'Length has not been measured yet.' : 'Measured audio duration'}">${esc(audioLength(r.durationMs))}</td><td class="menu-cell">${filter === 'all' && r.onDevice ? `<button class="row-remove" data-remove="${esc(r.key)}" title="${r.local ? 'Remove from Pocket. Your original files stay in your Inbox folder.' : 'Remove from Pocket. No original is in your Inbox folder.'}" aria-label="Remove ${esc(r.title)} from Pocket, but keep in library" ${locked ? 'disabled' : ''}>${icon('remove')}</button>` : ''}</td></tr>`;
    })
    .join('');
  $('empty').hidden = rows.length > 0;
  if (!rows.length) {
    $('empty').querySelector('h3').textContent = state.scanning
      ? state.scanMessage || 'Refreshing…'
      : state.rows.length
        ? 'No matching audio items'
        : 'No audio in Inbox';
    $('empty').querySelector('p').innerHTML = state.rows.length
      ? 'Try another search or view all audio items.'
      : 'Add ZIPs, 7z archives, or folders of MP3, M4A, or AAC<br>files to your Pocket Drop Inbox.';
  }
  if (!rows.length && filter === 'missing' && !state.device.connected) {
    $('empty').querySelector('h3').textContent = 'Connect Pocket to check your audio';
    $('empty').querySelector('p').textContent = 'Turn on USB storage when prompted on your device.';
  }
  $('rows')
    .querySelectorAll('[data-edit]')
    .forEach((e) => (e.onclick = () => studio?.openEditor(e.dataset.edit)));
  $('rows')
    .querySelectorAll('[data-error]')
    .forEach((e) => {
      const explain = () =>
        studio?.showProblem(
          state.rows.find((r) => r.key === e.dataset.error)?.problem ?? {
            summary: 'This item needs attention.',
            action: 'Review the details and Refresh after resolving the problem.',
            details: state.rows.find((r) => r.key === e.dataset.error)?.message,
          },
        );
      e.onclick = explain;
      e.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          explain();
        }
      };
    });
  $('rows')
    .querySelectorAll('[data-remove-select]')
    .forEach(
      (e) =>
        (e.onclick = () => {
          removeSelection.has(e.dataset.removeSelect)
            ? removeSelection.delete(e.dataset.removeSelect)
            : removeSelection.add(e.dataset.removeSelect);
          renderBooks();
        }),
    );
  $('rows')
    .querySelectorAll('[data-queue]')
    .forEach(
      (e) =>
        (e.onclick = () => {
          selected.has(e.dataset.queue)
            ? selected.delete(e.dataset.queue)
            : selected.add(e.dataset.queue);
          renderBooks();
        }),
    );
  $('rows')
    .querySelectorAll('[data-remove]')
    .forEach((e) => (e.onclick = () => call('remove', [e.dataset.remove])));
  $('sort-status').textContent = filter === 'device' ? 'Remove selection' : 'Status';
  $('row-actions-heading').hidden = filter === 'device';
  $('rows')
    .querySelectorAll('.menu-cell')
    .forEach((e) => (e.hidden = filter === 'device'));
  document.querySelectorAll('[data-sort]').forEach((e) => {
    const current = sorts[filter];
    e.parentElement.setAttribute(
      'aria-sort',
      current.key === e.dataset.sort ? (current.dir === 1 ? 'ascending' : 'descending') : 'none',
    );
  });
  const collectionsPending = !!state.collectionSyncNeeded;
  const chosen = state.rows.filter((r) => selected.has(r.key) && actionable(r)),
    onDevice = state.rows.filter((r) => r.onDevice && removeSelection.has(r.key));
  const removing = state.busy && state.operation === 'remove';
  $('selection-title').textContent =
    filter === 'device' || (filter === 'all' && onDevice.length)
      ? onDevice.length
        ? onDevice.length + ' selected for removal'
        : 'Select audio to remove from Pocket'
      : chosen.length
        ? chosen.length + ' in sync queue'
        : collectionsPending
          ? 'Collection changes ready to sync'
          : 'No audio items selected';
  $('selection-detail').textContent =
    filter === 'device' || (filter === 'all' && onDevice.length)
      ? ''
      : chosen.length
        ? bytes(chosen.reduce((n, r) => n + (r.transferBytes ?? r.size), 0)) + ' to transfer'
        : collectionsPending
          ? 'Sync will update your collections on Pocket.'
          : 'Select Not on Pocket to choose audio.';
  $('sync').hidden = filter === 'device';
  document.querySelector('.sync-controls').hidden = filter === 'device';
  $('sync').disabled =
    locked ||
    state.preparation?.running ||
    !state.device.connected ||
    !state.device.initialized ||
    (!chosen.length && !collectionsPending);
  $('remove-selected').hidden =
    (filter === 'missing' && !removing) || (filter !== 'device' && !onDevice.length && !removing);
  $('remove-selected').disabled = locked || !state.device.connected || !onDevice.length;
  const syncCount =
    state.busy && state.operation === 'sync'
      ? (state.operationCount ?? chosen.length)
      : chosen.length;
  const removeCount = removing ? (state.operationCount ?? onDevice.length) : onDevice.length;
  $('sync-label').textContent = syncCount
    ? `Sync ${syncCount} ${syncCount === 1 ? 'item' : 'items'}`
    : 'Sync';
  $('remove-label').textContent = removeCount
    ? `Remove ${removeCount} ${removeCount === 1 ? 'item' : 'items'}`
    : 'Remove from Pocket';
  $('sync').setAttribute(
    'aria-label',
    state.busy && state.operation === 'sync'
      ? `Syncing ${syncCount} items · ${Math.round(state.progress?.percent ?? 0)}%`
      : $('sync-label').textContent,
  );
  $('remove-selected').setAttribute(
    'aria-label',
    removing
      ? `Removing ${removeCount} items · ${Math.round(state.progress?.percent ?? 0)}%`
      : $('remove-label').textContent,
  );
  const preview = storagePreview(chosen, state.device, {
    plannedBytes: state.busy && state.operation === 'sync' ? state.plannedTransferBytes : undefined,
  });
  $('space-preview').hidden = !chosen.length || filter === 'device' || !state.device.connected;
  $('space-preview').classList.toggle('capacity-warning', preview.overCapacity);
  $('space-preview').textContent = preview.overCapacity
    ? 'Queue may exceed free space.'
    : preview.unknown
      ? `${bytes(state.device.free)} free now · final size after Opus conversion`
      : `Est. free after sync: ${bytes(Math.max(0, preview.remaining ?? 0))}`;
  $('space-preview').title = preview.unknown
    ? `${preview.unknown} Opus item(s) need conversion before their final size is known.`
    : 'Estimated remaining space. Available space is checked before writing.';
  $('missing-count').textContent = state.device.connected
    ? scope.filter((r) => r.local && !r.onDevice).length
    : '—';
  document.querySelector('[data-filter=missing]').disabled = !state.device.connected;
  document.querySelector('[data-filter=missing]').title = state.device.connected
    ? 'Show local audio not on this Pocket'
    : 'Connect Pocket to check which audio is missing';
  $('all-count').textContent = scope.length;
  $('device-count').textContent = scope.filter((r) => r.onDevice).length;
  $('count').textContent = state.rows.filter((r) => !r.hidden).length;
  document
    .querySelectorAll('[data-filter]')
    .forEach((e) => e.classList.toggle('active', filter === e.dataset.filter));
}

function render() {
  const textSize = [16, 18, 20, 22].includes(state.settings?.libraryTextSize)
    ? state.settings.libraryTextSize
    : 18;
  document.documentElement.style.setProperty('--library-text', textSize + 'px');
  $('library-text-size').value = String(textSize);
  const appText = [14, 16, 18, 20].includes(state.settings?.appTextSize)
    ? state.settings.appTextSize
    : 14;
  document.documentElement.style.setProperty('--app-text', appText + 'px');
  $('app-text-size').value = String(appText);
  const titleWidth = [220, 240, 260, 280, 300, 320, 340, 360, 380, 400, 420].includes(
    state.settings?.titleColumnWidth,
  )
    ? state.settings.titleColumnWidth
    : 280;
  document.documentElement.style.setProperty('--title-column-width', titleWidth + 'px');
  $('title-column-width').value = String(titleWidth);
  $('title-column-value').textContent = titleWidth + ' px';
  $('rename-drive').disabled = state.busy || !state.device.connected;
  $('drive-name-detail').textContent = state.device.connected
    ? 'Current name: ' + (state.device.volume?.split('/').at(-1) ?? 'Y2 MAIN')
    : 'Connect MYO Pocket to rename its onboard storage.';
  $('open-on-connect').checked = state.settings?.openOnConnect === true;
  const refreshing = state.refreshing ?? (state.loading || state.scanning);
  $('refresh').classList.toggle('refreshing', !!refreshing);
  $('refresh').setAttribute('aria-busy', String(!!refreshing));
  document.querySelector('.refresh-caption').textContent = refreshing
    ? state.scanMessage === 'Importing new audio…'
      ? state.scanMessage
      : 'Refreshing…'
    : 'Refresh';
  const syncing = state.busy && state.operation === 'sync';
  const amount = Math.max(0, Math.min(100, state.progress?.percent ?? 0));
  $('sync').classList.toggle('transferring', syncing);
  $('sync').style.setProperty('--sync-progress', amount + '%');
  $('sync').setAttribute('aria-busy', String(syncing));
  $('sync').setAttribute('aria-label', syncing ? 'Syncing ' + amount + '%' : 'Sync');
  const removing = state.busy && state.operation === 'remove';
  $('remove-selected').classList.toggle('transferring', removing);
  $('remove-selected').style.setProperty('--remove-progress', amount + '%');
  $('remove-selected').setAttribute('aria-busy', String(removing));
  $('remove-selected').setAttribute(
    'aria-label',
    removing ? 'Removing ' + amount + '%' : 'Remove from Pocket',
  );

  $('eject').disabled = state.busy || !state.device.connected;
  $('connection-check').hidden = !state.device.connected;
  const d = state.device;
  const ejecting = state.busy && state.operation === 'eject' && d.connected;
  $('eject').classList.toggle('ejecting', ejecting);
  $('eject').hidden = ejecting;
  $('eject-status-icon').hidden = !ejecting;
  $('connection-check').hidden = !d.connected || ejecting;
  $('eject').setAttribute('aria-busy', String(ejecting));
  document.querySelector('.eject-caption').textContent = ejecting ? 'Ejecting…' : 'Eject';
  $('device-panel').classList.toggle('connected', d.connected);
  document.querySelector('.device-status').title = d.connected
    ? 'Pocket connected'
    : 'Connect with a USB data cable. Turn on USB storage when prompted on your device.';
  const used = d.connected && d.total ? Math.round(((d.total - d.free) / d.total) * 100) : 0;
  $('header-meter').hidden = !d.connected;
  $('header-meter').setAttribute('aria-valuenow', used);
  $('header-fill').style.width = Math.max(0, Math.min(100, used)) + '%';
  $('connection').classList.toggle('connected', d.connected);
  $('device-state-label').textContent = ejecting
    ? 'Ejecting, please wait…'
    : d.connected
      ? 'Connected'
      : 'Disconnected';
  $('connection-title').textContent = state.settings?.pocketName || 'MYO Pocket';
  $('connection-detail').textContent = d.connected
    ? `${bytes(d.free)} free of ${bytes(d.total)}`
    : 'Turn on USB storage when prompted on your device.';
  $('connection-detail').hidden = false;
  const minutes = Math.floor((d.audioDurationMs ?? 0) / 60000);
  $('device-audio-duration').hidden = !d.connected || !d.initialized;
  $('device-audio-duration').textContent =
    `${d.durationIncomplete ? 'At least ' : ''}${Math.floor(minutes / 60)} hours, ${minutes % 60} minutes of audio`;
  $('device-banner').hidden = !(d.connected && !d.initialized) || state.busy;
  $('device-banner').innerHTML =
    'MYO Pocket is connected. Create its Studio Pocket library to start syncing. <button class="text-button" id="init">Create library…</button>';
  if ($('init')) $('init').onclick = () => call('initialize');
  $('refresh').disabled = state.busy || refreshing;
  $('add-files').disabled = state.busy || state.scanning;
  $('choose-inbox').disabled = state.busy || state.scanning;
  $('refresh-interval').disabled = state.busy || state.scanning;
  const operationProgress = state.progress;
  $('progress-panel').hidden = !operationProgress;
  $('cancel').hidden = !(state.busy && state.operation === 'sync');
  if (operationProgress) {
    $('progress-title').textContent = operationProgress.phase;
    $('progress-title').title = operationProgress.phase;
    $('progress').value = operationProgress.percent ?? 0;
    $('progress').hidden = true;
  }
  $('storage-message').textContent = d.connected
    ? `${state.rows.filter((r) => r.onDevice).length} audio items on your player. ${bytes(d.free)} free.`
    : 'Connect your MYO Pocket with a USB data cable and enable USB storage.';
  $('storage-used').textContent = d.connected ? bytes(d.total - d.free) : '—';
  $('storage-free').textContent = d.connected ? bytes(d.free) : '—';
  $('storage-total').textContent = d.connected ? bytes(d.total) : '—';
  $('storage-fill').style.width = d.connected
    ? Math.min(100, ((d.total - d.free) / d.total) * 100) + '%'
    : '0%';
  $('inbox-path').textContent = state.inbox ?? '';
  $('refresh-interval').value =
    state.settings?.autoRefresh === false ? '0' : String(state.settings?.refreshSeconds ?? 30);
  $('build-architecture').textContent = state.arch === 'arm64' ? 'Apple Silicon' : 'Intel';
  $('about-version').textContent = state.version ?? '4.0.0';
  $('version').textContent = state.version ?? '4.0';
  const result = state.lastResult;
  $('completion-banner').hidden = !result || result.id === dismissedResult || state.busy;
  $('completion-banner').className = 'completion-banner ' + (result?.tone ?? '');
  $('completion-message').textContent = result?.message ?? '';
  $('logs').innerHTML = state.logs?.length
    ? state.logs
        .map(
          (l) =>
            `<div class="log ${esc(l.tone)}"><div class="log-icon">${icon(l.tone === 'success' ? 'check' : l.tone === 'error' ? 'alert' : 'clock')}</div><div class="log-text">${esc(l.text)}<span class="log-time">${esc(new Date(l.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span></div></div>`,
        )
        .join('')
    : '<div class="empty">No activity yet.</div>';
  renderBooks();
  studio?.render(state);
}
function receive(next) {
  state = next;
  const keys = new Set(state.rows.map((r) => r.key));
  selected = new Set(
    [...selected].filter((k) => keys.has(k) && actionable(state.rows.find((r) => r.key === k))),
  );
  removeSelection = new Set(
    [...removeSelection].filter(
      (k) => keys.has(k) && state.rows.find((r) => r.key === k)?.onDevice,
    ),
  );
  render();
}
$('edit-pocket-name').onclick = $('connection-title').onclick = () => {
  $('pocket-name-input').value = state.settings?.pocketName || 'MYO Pocket';
  $('pocket-name-dialog').showModal();
  $('pocket-name-input').select();
};
$('pocket-name-cancel').onclick = () => $('pocket-name-dialog').close();
$('pocket-name-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('pocket-name-input').value.trim();
  if (!name) {
    $('pocket-name-input').setCustomValidity('Enter a Pocket name.');
    $('pocket-name-input').reportValidity();
    return;
  }
  $('pocket-name-dialog').close();
  await call('pocketName', name);
};
$('pocket-name-input').oninput = () => $('pocket-name-input').setCustomValidity('');
$('open-on-connect').onchange = (e) => call('openOnConnect', e.target.checked);
$('open-diagnostics').onclick = () => call('openDiagnostics');
$('clear-audio-cache').onclick = () => call('clearAudioCache');
$('myo-site').onclick = $('open-myo-studio').onclick = () => call('myoWebsite');
$('app-text-size').onchange = (e) => call('appTextSize', Number(e.target.value));
$('title-column-width').oninput = (e) => {
  document.documentElement.style.setProperty('--title-column-width', e.target.value + 'px');
  $('title-column-value').textContent = e.target.value + ' px';
};
$('title-column-width').onchange = (e) => call('titleColumnWidth', Number(e.target.value));
$('rename-drive').onclick = () => {
  $('drive-name').value = state.device.volume?.split('/').at(-1) ?? 'MYO POCKET';
  $('rename-dialog').showModal();
  $('drive-name').select();
};
$('rename-cancel').onclick = () => $('rename-dialog').close();
$('rename-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('drive-name').value.trim();
  $('rename-dialog').close();
  await call('renameDrive', name);
};
$('open-inbox').onclick =
  $('empty-open').onclick =
  $('settings-open').onclick =
    () => call('openInbox');
$('refresh').onclick = () => call('refresh');
$('add-files').onclick = async () => showImportResult(await call('add', 'files'));
$('choose-inbox').onclick = () => call('chooseInbox');
$('library-text-size').onchange = (e) => call('libraryTextSize', Number(e.target.value));
$('refresh-interval').onchange = (e) => call('refreshInterval', Number(e.target.value));
$('manage-storage').onclick = () => {
  filter = 'device';
  showPage('books');
  render();
};
$('eject').onclick = () => call('eject');
$('sync').onclick = () =>
  call(
    'sync',
    state.rows.filter((r) => selected.has(r.key) && actionable(r)).map((r) => r.key),
  );
$('remove-selected').onclick = () =>
  call(
    'remove',
    state.rows.filter((r) => removeSelection.has(r.key) && r.onDevice).map((r) => r.key),
  );
$('cancel').onclick = () => call('cancel');
document.addEventListener('click', () =>
  document.querySelectorAll('.popover').forEach((p) => p.remove()),
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.popover').forEach((p) => p.remove());
});
function showImportResult(result) {
  if (result)
    toast(
      result.imported
        ? `${result.imported} ${result.imported === 1 ? 'item copied' : 'items copied'} to Inbox.`
        : 'Those items are already in your Inbox.',
    );
}
$('dismiss-result').onclick = () => {
  dismissedResult = state.lastResult?.id;
  $('completion-banner').hidden = true;
};
$('result-details').onclick = () => {
  const r = state.lastResult;
  if (!r) return;
  if (r.problem) {
    studio.showProblem(r.problem);
    return;
  }
  $('result-heading').textContent = r.kind === 'remove' ? 'Removal details' : 'Sync details';
  $('result-list').innerHTML =
    (r.details ?? [])
      .map(
        (item) =>
          `<div class="result-item"><strong>${esc(item.title)}</strong><p>${esc(item.message)}</p></div>`,
      )
      .join('') + (r.warnings ?? []).map((w) => `<p class="result-warning">${esc(w)}</p>`).join('');
  $('result-dialog').showModal();
};
$('close-result').onclick = () => $('result-dialog').close();
const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
function clearDrag() {
  dragDepth = 0;
  $('drop-overlay').hidden = true;
}
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('drop-overlay').hidden = page !== 'books';
  $('drop-title').textContent =
    state.busy || state.scanning ? 'Please wait for the current operation' : 'Drop audio here';
});
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = state.busy || state.scanning ? 'none' : 'copy';
});
document.addEventListener('dragleave', (e) => {
  if (dragDepth > 0 && --dragDepth <= 0) clearDrag();
});
document.addEventListener('dragend', clearDrag);
document.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  clearDrag();
  if (state.busy || state.scanning) {
    toast('Please wait for the current operation, then drop the files again.');
    return;
  }
  try {
    const result = await api.importFiles(Array.from(e.dataTransfer.files));
    showPage('books');
    showImportResult(result);
  } catch (error) {
    toast(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
  }
});
studio = installStudioUI({
  api,
  call,
  esc,
  bytes,
  icon,
  toast,
  getState: () => state,
  renderBooks,
  showPage,
});
if (api) {
  api.subscribe(receive);
  call('state').then((s) => s && receive(s));
} else {
  render();
  toast('Open Pocket Drop as a desktop application to access your Inbox and player.');
}
