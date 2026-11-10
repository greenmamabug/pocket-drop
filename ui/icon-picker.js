// SPDX-License-Identifier: GPL-3.0-only
export function installIconPicker({ request, guarded, getDocument, assign, esc, getState }) {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<dialog id="icon-picker" class="studio-dialog icon-picker" aria-labelledby="icon-picker-title"><div class="editor-heading"><div><span class="eyebrow">TRACK ARTWORK</span><h3 id="icon-picker-title">Choose an icon</h3></div><button class="text-button" id="icon-picker-close">Close</button></div><form id="icon-search-form" class="icon-search-form"><label>Source<select id="icon-source"><option value="local">This audio</option><option value="yoto">Yoto icons</option><option value="community">Yotoicons.com</option><option value="personal">My Yoto icons</option></select></label><label>Search icons<input id="icon-query" type="search" maxlength="80" placeholder="Try cat, music, space…"></label><button class="button" type="submit">Search</button></form><p id="icon-search-status" role="status"></p><div id="icon-results" class="icon-results"></div><div class="inline-buttons"><button class="text-button" id="icon-previous">Previous</button><button class="text-button" id="icon-next">Next</button><button class="text-button" id="icon-import-file">Choose image file…</button><button class="text-button" id="icon-source-link">View source website</button></div><p class="hint">Choosing an icon updates this track. Save your audio details to keep the change.</p></dialog>`,
  );
  const $ = (id) => document.getElementById(id),
    dialog = $('icon-picker');
  let trackKey,
    page = 0,
    generation = 0,
    selecting = false;
  const source = () => $('icon-source').value;
  function close() {
    if (selecting) return;
    ++generation;
    dialog.close();
  }
  $('icon-picker-close').onclick = close;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  async function choose(icon, remote, id) {
    if (selecting || getDocument()?.id !== id) return;
    selecting = true;
    const controls = [...dialog.querySelectorAll('button,input,select')];
    controls.forEach((e) => {
      e.disabled = true;
    });
    try {
      const result = remote ? await request('chooseRemoteIcon', id, icon.key) : icon;
      if (getDocument()?.id !== id) return;
      assign(trackKey, result);
      ++generation;
      dialog.close();
    } finally {
      selecting = false;
      controls.forEach((e) => {
        e.disabled = false;
      });
    }
  }
  async function search() {
    const doc = getDocument();
    if (!doc || selecting) return;
    const run = ++generation,
      id = doc.id,
      query = $('icon-query').value.trim(),
      provider = source();
    $('icon-results').replaceChildren();
    $('icon-search-status').textContent = provider === 'local' ? '' : 'Finding icons…';
    $('icon-previous').hidden = $('icon-next').hidden = true;
    $('icon-source-link').hidden = !['yoto', 'community'].includes(provider);
    try {
      let result;
      if (provider === 'local') {
        const icons = [{ key: '', name: 'Default icon' }, ...doc.icons].filter(
          (i) => !query || i.name.toLowerCase().includes(query.toLowerCase()),
        );
        result = {
          items: icons.slice(page * 48, (page + 1) * 48),
          more: icons.length > (page + 1) * 48,
        };
      } else if (provider === 'personal' && !getState().yotoAccount?.connected) {
        result = {
          items: [],
          message:
            'Connect your Yoto account in Settings to browse personal icons. Standard Yoto icons work without an account.',
        };
      } else result = await request('searchIcons', id, provider, query, page);
      if (run !== generation || getDocument()?.id !== id || !dialog.open) return;
      $('icon-results').innerHTML = result.items
        .map(
          (icon, index) =>
            `<button class="icon-tile" data-icon-choice="${index}" data-icon-key="${esc(icon.key)}" title="${esc(icon.name + (icon.author ? ' · @' + icon.author : ''))}" aria-label="${esc(icon.name)}">${icon.url ? `<img src="${esc(icon.url)}" alt="">` : '<span class="default-icon">♪</span>'}<span>${esc(icon.name)}</span>${icon.author ? `<small>@${esc(icon.author)}</small>` : ''}</button>`,
        )
        .join('');
      $('icon-search-status').textContent =
        result.message || (result.items.length ? '' : 'No icons found. Try another word.');
      $('icon-previous').hidden = page === 0;
      $('icon-next').hidden = !result.more;
      $('icon-results')
        .querySelectorAll('[data-icon-choice]')
        .forEach((button) => {
          button.onclick = guarded(() =>
            choose(result.items[Number(button.dataset.iconChoice)], provider !== 'local', id),
          );
        });
    } catch (error) {
      if (run === generation) $('icon-search-status').textContent = error.message;
    }
  }
  $('icon-search-form').onsubmit = (event) => {
    event.preventDefault();
    page = 0;
    void search();
  };
  $('icon-source').onchange = () => {
    page = 0;
    void search();
  };
  $('icon-query').oninput = () => {
    if (source() === 'local') {
      page = 0;
      void search();
    }
  };
  $('icon-previous').onclick = () => {
    page--;
    void search();
  };
  $('icon-next').onclick = () => {
    page++;
    void search();
  };
  $('icon-source-link').onclick = guarded(() =>
    request('iconSourceWebsite', source(), $('icon-query').value),
  );
  $('icon-import-file').onclick = guarded(async () => {
    const id = getDocument()?.id;
    if (!id) return;
    const icon = await request('pickArtwork', id, 'icon');
    if (icon && getDocument()?.id === id) {
      assign(trackKey, icon);
      close();
    }
  });
  return {
    open(key, find = false) {
      trackKey = key;
      page = 0;
      $('icon-query').value = '';
      $('icon-source').value = find ? 'yoto' : 'local';
      dialog.showModal();
      void search();
    },
  };
}

export function installYotoSettings({ request, guarded }) {
  const $ = (id) => document.getElementById(id);
  $('yoto-connect').onclick = guarded(() => request('yotoConnect', $('yoto-client-id').value));
  $('yoto-cancel').onclick = guarded(() => request('yotoCancel'));
  $('yoto-disconnect').onclick = guarded(() => request('yotoDisconnect'));
  $('yoto-setup').onclick = guarded(() => request('yotoSetup'));
  return {
    render(state) {
      const account = state.yotoAccount ?? {};
      if (document.activeElement !== $('yoto-client-id') && !$('yoto-client-id').value)
        $('yoto-client-id').value = account.clientId || '';
      $('yoto-client-id').disabled = !!account.connecting || !!account.connected;
      $('yoto-connect').hidden = !!account.connected || !!account.connecting;
      $('yoto-connect').disabled = account.secureStorage === false || !!account.disconnecting;
      $('yoto-cancel').hidden = !account.connecting;
      $('yoto-disconnect').hidden = !account.connected;
      $('yoto-account-status').textContent =
        account.error ||
        (account.connecting
          ? 'Complete sign-in in your browser…'
          : account.connected
            ? 'Yoto connected · personal icons available'
            : account.secureStorage === false
              ? 'Secure credential storage is unavailable on this computer.'
              : 'Optional: connect to browse your personal Yoto icons.');
    },
  };
}
