import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
const server = http.createServer(async (req, res) => {
  try {
    const file = path.resolve('.' + decodeURIComponent(req.url));
    if (!file.startsWith(process.cwd() + path.sep)) throw new Error();
    res.setHeader(
      'Content-Type',
      /\.m?js$/.test(file)
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.png')
            ? 'image/png'
            : 'text/html',
    );
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const state = {
    version: '4.4.0',
    inbox: '/Inbox',
    settings: {},
    device: { connected: true, initialized: true, deviceId: 'test', free: 1e9, total: 2e9 },
    logs: [],
    rows: [
      {
        key: 'one',
        durationMs: 29700000,
        needsConversion: true,
        opusCount: 1,
        id: 'a-story',
        title: 'A story',
        source: 'Original.zip',
        local: true,
        onDevice: false,
        status: 'ready',
        tracks: 2,
        size: 123456,
        searchTracks: ['An opening', 'An ending'],
      },
      {
        key: 'two',
        durationMs: 2700000,
        id: 'second',
        title: 'Another story',
        source: 'Another.zip',
        local: true,
        onDevice: false,
        status: 'ready',
        tracks: 2,
        size: 123456,
      },
    ],
    collections: [],
  };
  await page.addInitScript((state) => {
    window.state = state;
    window.state.rows.forEach((row, index) => {
      row.cover =
        'data:image/svg+xml,' +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="252" height="400"><rect width="252" height="400" rx="16" fill="${index ? '#207a72' : '#6f389f'}"/><text x="28" y="90" fill="white" font-size="24">Audio ${index + 1}</text></svg>`,
        );
    });
    window.calls = [];
    window.doc = {
      id: 'session',
      rowKey: 'one',
      title: 'A story',
      tags: [],
      cover: null,
      coverRef: null,
      coverMode: 'fit',
      coverPosition: 50,
      icons: [
        { key: 'icons/one.png', name: 'First icon', url: '' },
        { key: 'icons/two.png', name: 'Second icon', url: '' },
      ],
      tracks: [
        {
          key: 'audio/01.mp3',
          size: 123456,
          durationMs: 125000,
          title: 'An opening',
          filename: '01.mp3',
          iconKey: 'icons/one.png',
          url: 'pocket-media://preview/one',
        },
        {
          key: 'audio/02.mp3',
          size: 234567,
          durationMs: 186000,
          title: 'An ending',
          filename: '02.mp3',
          iconKey: 'icons/two.png',
          url: 'pocket-media://preview/two',
        },
      ],
      canTrashOriginals: true,
    };
    window.doc.defaults = {
      title: 'A story',
      tracks: structuredClone(window.doc.tracks),
      cover: null,
    };
    window.pocket = {
      subscribe: (fn) => (window.sendState = fn),
      invoke: async (method, ...args) => {
        window.calls.push([method, ...args]);
        if (method === 'state') return window.state;
        if (method === 'openEditor') return structuredClone(window.doc);
        if (method === 'editorMetrics')
          return {
            running: false,
            tracks: window.doc.tracks.map(({ key, size, durationMs }) => ({
              key,
              size,
              durationMs,
            })),
          };
        if (method === 'saveEditor') {
          window.saved = args[1];
          return { saved: true };
        }
        if (method === 'saveCollections') {
          window.state.collections = args[0];
          window.state.collectionPictures = { ...window.state.collectionPictures, ...args[1] };
          window.sendState(window.state);
          return args[0];
        }
        if (method === 'pickCollectionPicture')
          return {
            ref: 'asset:sample.png',
            iconRef: 'asset:icon.png',
            imageRef: 'asset:portrait.png',
            thumbnail: window.state.rows[0].cover,
            cardThumbnail: window.state.rows[0].cover,
          };
        if (method === 'checkUpdates')
          return {
            status: 'available',
            current: '4.4.0',
            version: '4.5.0',
            notes: 'New changes',
            url: 'https://github.com/test/releases/intel.zip',
          };
        if (method === 'compareDuplicates')
          return {
            items: args[0].map((key) => ({
              key,
              source: key + '.zip',
              tracks: 2,
              comparison: 'Identical audio in the same order',
            })),
          };
        if (method === 'preferImport') {
          window.state.rows.find((r) => r.key === 'duplicate').hidden = true;
          window.sendState(window.state);
        }
        if (method === 'restoreHidden') {
          window.state.rows.find((r) => r.key === 'duplicate').hidden = false;
          window.sendState(window.state);
        }
        return {};
      },
    };
  }, state);
  await page.goto('http://127.0.0.1:' + server.address().port + '/ui/index.html');
  await page.locator('.audio-open').first().waitFor();
  await page.locator('[data-edit=one]').click();
  await page.locator('#audio-editor').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-track-metrics]').first().innerText(), '2m 5s · 123 KB');
  await page
    .locator('[data-track-grip=\"audio/02.mp3\"]')
    .dragTo(page.locator('[data-track-row=\"audio/01.mp3\"]'));
  assert.equal(await page.locator('[data-track-title]').first().inputValue(), 'An ending');
  await page
    .locator('[data-track-grip=\"audio/01.mp3\"]')
    .dragTo(page.locator('[data-track-row=\"audio/02.mp3\"]'));
  assert.equal(await page.locator('[data-track-title]').first().inputValue(), 'An opening');
  await page.locator('#editor-title').fill('My renamed story');
  assert.equal(await page.locator('#editor-tags').count(), 0);
  await page.locator('[data-track-up="audio/02.mp3"]').click();
  assert.equal(await page.locator('[data-track-title]').first().inputValue(), 'An ending');
  await page.locator('[data-track-title="audio/02.mp3"]').fill('My opening');
  await page.locator('[data-track-icon="audio/02.mp3"]').selectOption('icons/one.png');
  await page.locator('[data-track-delete="audio/01.mp3"]').click();
  assert.equal(await page.locator('[data-track-delete="audio/01.mp3"]').innerText(), 'Restore');
  await page.locator('#editor-save-only').click();
  const saved = await page.evaluate(() => window.saved);
  assert.equal(saved.title, 'My renamed story');
  assert.deepEqual(saved.tags, []);
  assert.equal(saved.tracks[0].key, 'audio/02.mp3');
  assert.equal(saved.tracks[0].iconKey, 'icons/one.png');
  assert.equal(saved.tracks[1].excluded, true);
  assert.ok(await page.locator('#audio-editor').isVisible());
  assert.equal(await page.locator('#editor-save-only').innerText(), 'Save');
  assert.equal(await page.locator('#editor-save').innerText(), 'Save and close');
  assert.ok(!(await page.evaluate(() => window.calls)).some((c) => c[0] === 'prepareAudio'));
  await page.screenshot({ path: 'release/Track-editor-440.png' });
  await page.locator('#editor-title').fill('Saved and closed');
  await page.locator('#editor-save').click();
  await page.locator('#audio-editor').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.saved.title), 'Saved and closed');
  assert.equal(await page.locator('#rows .length').first().innerText(), '8h 15m');
  await page.locator('[data-sort=length]').click();
  assert.equal(await page.locator('#rows .length').first().innerText(), '45m');
  await page.locator('[data-sort=length]').click();
  assert.equal(await page.locator('#rows .length').first().innerText(), '8h 15m');
  await page.screenshot({ path: 'release/Library-length-443.png' });
  await page.evaluate(() => {
    window.state.collectionSyncNeeded = true;
    window.state.rows = window.state.rows.map((r) => ({ ...r, onDevice: true, status: 'current' }));
    window.sendState(window.state);
  });
  assert.ok(await page.locator('#sync').isEnabled());
  assert.equal(
    await page.locator('#selection-title').innerText(),
    'Collection changes ready to sync',
  );
  await page.locator('#sync').click();
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ['sync', []]);
  await page.evaluate(() => {
    window.state.collectionSyncNeeded = false;
    window.state.rows = window.state.rows.map((r) => ({ ...r, onDevice: false, status: 'ready' }));
    window.sendState(window.state);
  });
  await page.locator('#search').fill('An ending');
  assert.equal(await page.locator('#rows tr').count(), 1);
  await page.locator('#search').fill('');
  await page.locator('[data-page=collections]').click();
  await page.locator('#new-collection').click();
  await page.locator('#collection-name').fill('Bedtime');
  await page.locator('[data-member=a-story]').check();
  await page.locator('[data-member=second]').check();
  await page.locator('[data-member-up=second]').click();
  await page.locator('#collection-look').selectOption('covers');
  assert.equal(await page.locator('#collection-card-preview .stack-card').count(), 2);
  await page.locator('[data-cover-up="1"]').click();
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector('#collection-card-preview img').getAttribute('src') ===
        window.state.rows.find((r) => r.id === 'a-story').cover,
    ),
    true,
  );
  await page
    .locator('#collection-card-preview img')
    .evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  await page.screenshot({ path: '/tmp/pocket-collection-editor.png' });
  await page.locator('#collection-save').click();
  const groups = await page.evaluate(() => window.state.collections);
  assert.equal(groups[0].title, 'Bedtime');
  assert.deepEqual(groups[0].playlists, ['second', 'a-story']);
  assert.equal(groups[0].display, 'covers');
  assert.deepEqual(groups[0].covers, ['a-story', 'second']);
  await page.locator('[data-group-edit]').first().click();
  await page.locator('#collection-picture-change').click();
  assert.equal(await page.locator('#collection-card-preview .stack-card').count(), 3);
  await page.locator('#collection-use-picture').uncheck();
  assert.equal(await page.locator('#collection-card-preview .stack-card').count(), 2);
  await page.locator('#collection-look').selectOption('image');
  assert.equal(await page.locator('#collection-card-preview .stack-card').count(), 1);
  await page.locator('#collection-save').click();
  await page.locator('#new-collection').click();
  await page.locator('#collection-name').fill('Music');
  await page.locator('[data-member=second]').check();
  await page.locator('#collection-save').click();
  const moved = await page.evaluate(() => window.state.collections);
  assert.deepEqual(moved[0].playlists, ['a-story']);
  assert.deepEqual(moved[0].covers, ['a-story']);
  assert.equal(moved[0].display, 'image');
  assert.equal(moved[1].display, 'recent');
  await page.screenshot({ path: '/tmp/pocket-collection-looks.png' });
  await page.screenshot({ path: 'release/Collections-440.png' });
  await page.locator('[data-page=books]').click();
  assert.equal(await page.locator('#books #prepare-audio,#collection-filter').count(), 0);
  await page.locator('[data-page=settings]').click();
  await page.locator('#prepare-audio').click();
  await page.locator('[data-prepare-item=one]').check();
  await page.locator('#prepare-start').click();
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ['prepareAudio', ['one']]);
  await page.locator('[data-page=books]').click();
  await page.evaluate(() => {
    window.state.preparation = {
      running: true,
      phase: 'Converting Opus to AAC',
      percent: 35,
      startedAt: Date.now() - 20000,
      elapsedMs: 20000,
      remainingMs: 40000,
      file: 'Chapter.opus',
      fileIndex: 2,
      fileTotal: 5,
    };
    window.sendState(window.state);
  });
  assert.ok(await page.locator('#eject').isEnabled());
  assert.ok(await page.locator('#preparation-status').isVisible());
  await page.locator('[data-page=activity]').click();
  assert.ok(await page.locator('#activity').isVisible());
  await page.locator('[data-page=books]').click();
  await page.locator('#cancel-preparation').click();
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ['cancelPreparation']);
  await page.evaluate(() => {
    window.state.preparation = { ...window.state.preparation, running: false };
    window.state.rows.push({ ...window.state.rows[0], key: 'duplicate', source: 'Duplicate.zip' });
    window.state.duplicates = {
      checking: false,
      groups: [
        {
          title: 'A story',
          items: ['one', 'duplicate'].map((key) => ({
            key,
            source: key + '.zip',
            tracks: 2,
            comparison: 'Identical audio in the same order',
          })),
        },
      ],
    };
    window.sendState(window.state);
  });
  await page.locator('#compare-imports').click();
  await page.locator('[data-compare-group]').click();
  await page.locator('[data-prefer=one]').click();
  assert.equal(await page.locator('#rows tr').count(), 2);
  await page.locator('[data-page=settings]').click();
  await page.locator('[data-unhide=duplicate]').click();
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ['restoreHidden', 'duplicate']);
  await page.locator('#completion-notifications').check();
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), [
    'completionNotifications',
    true,
  ]);
  await page.locator('#check-updates').click();
  assert.ok((await page.locator('#update-status').innerText()).includes('4.5.0'));
  await page.locator('#download-update').click();
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ['downloadUpdate']);
  await page.locator('[data-page=books]').click();
  await page.evaluate(() => {
    window.state.rows.push({
      key: 'bad',
      title: 'Bad audio',
      local: true,
      status: 'error',
      problem: {
        summary: 'An audio file is unsupported.',
        action: 'Use MP3 or AAC.',
        files: ['Bad.flac'],
        details: '<script>unsafe</script>',
      },
    });
    window.sendState(window.state);
  });
  await page.locator('[data-error=bad]').click();
  assert.equal(await page.locator('#problem-files').innerText(), 'Bad.flac');
  assert.equal(await page.locator('#problem-details').textContent(), '<script>unsafe</script>');
  await page.locator('#problem-close').click();
  await page.evaluate(() => {
    const invoke = window.pocket.invoke;
    window.pocket.invoke = async (method, ...args) =>
      method === 'openEditor'
        ? new Promise(
            (resolve) => (window.finishOpening = () => resolve(structuredClone(window.doc))),
          )
        : invoke(method, ...args);
  });
  await page.locator('[data-edit=one]').click();
  assert.equal(await page.locator('[data-edit=one]').getAttribute('aria-busy'), 'true');
  await page.evaluate(() => window.sendState(window.state));
  assert.ok(await page.locator('[data-edit=one]').evaluate((e) => e.classList.contains('opening')));
  await page.evaluate(() => {
    document.getElementById('toast').hidden = true;
  });
  assert.ok(await page.locator('[data-edit=one] .edit-title-icon').isVisible());
  await page.evaluate(() => window.finishOpening());
  await page.locator('#audio-editor').waitFor({ state: 'visible' });
  await page.locator('#editor-save').click();
  await page.locator('#audio-editor').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 960, height: 700 });
  await page.locator('[data-page=settings]').click();
  await page.evaluate(() => {
    window.state.playerUpdate = {
      supported: true,
      phase: 'prepared',
      running: false,
      token: 'reviewed-update',
      firmwareDir: '/Users/Test/Player Backups',
      summary: {
        unitId: '1234567890abcdef1234567890abcdef',
        checklist: ['Only this player’s measured system partition is written.'],
      },
      label: 'Backup saved and update prepared.',
    };
    window.sendState(window.state);
  });
  await page.locator('#manage-player').click();
  assert.equal(await page.locator('#player-write').isDisabled(), true);
  await page.locator('#player-confirm-write').fill('WRITE');
  assert.equal(await page.locator('#player-write').isDisabled(), false);
  await page.locator('#player-write').click();
  await page.locator('#player-update-close').click();
  await page.evaluate(() => {
    window.state.busy = true;
    window.state.operation = 'player-update';
    window.state.device.connected = false;
    Object.assign(window.state.playerUpdate, {
      action: 'prepare',
      running: true,
      startedAt: 1234,
      connectionAttempt: 1,
      connectionPhase: 'waiting',
      label: 'Waiting for player',
      details: ['USB reader started'],
    });
    window.sendState(window.state);
  });
  await page.locator('#player-connection-guide').waitFor({ state: 'visible' });
  await page.locator('#player-guide-diagram').waitFor({ state: 'visible' });
  assert.equal(
    await page.locator('#device-panel').evaluate((e) => e.classList.contains('connected')),
    true,
  );
  assert.equal(await page.locator('#manage-player').innerText(), 'View update progress…');
  await page.evaluate(() => {
    window.state.playerUpdate.connectionPhase = 'handshake';
    window.sendState(window.state);
  });
  assert.equal(await page.locator('#player-guide-title').innerText(), 'Player detected');
  await page.locator('#player-connection-guide').waitFor({ state: 'hidden' });
  await page.locator('#view-player-progress').click();
  await page.locator('#player-operation-details').click();
  assert.match(await page.locator('#player-detail-lines').innerText(), /USB reader started/);

  assert.ok(
    await page.evaluate(() =>
      window.calls.some(
        (c) => c[0] === 'playerWrite' && c[1] === 'WRITE' && c[2] === 'reviewed-update',
      ),
    ),
  );
  await page.evaluate(() => {
    window.state.busy = true;
    Object.assign(window.state.playerUpdate, {
      running: true,
      phase: 'writing',
      action: 'write',
      token: null,
      label: 'Writing player software — do not unplug',
      percent: 35,
    });
    window.sendState(window.state);
  });
  assert.equal(await page.locator('#player-cancel').isHidden(), true);
  assert.equal(await page.locator('#player-read').isDisabled(), true);
  assert.equal(await page.locator('#player-confirm-write').inputValue(), '');
  assert.equal(await page.locator('#player-update-progress').getAttribute('value'), '35');
  assert.equal(await page.locator('#device-state-label').innerText(), 'Updating player software');
  assert.match(await page.locator('#connection-detail').innerText(), /Do not unplug/);
  await page.screenshot({ path: '/tmp/pocket-player-update-preview.png' });
  await page.locator('#player-update-close').click();
  await page.locator('#manage-player').click();
  assert.match(await page.locator('#player-update-status').innerText(), /Writing player software/);
  await page.locator('#player-update-close').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 960);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: track editing/icon reassignment/exclusion, saved draft payload, track search, collection membership/order, offline preparation controls, duplicate preference/restore, notifications, update UI, safe error details and 960px layout.',
  );
} finally {
  await browser.close();
  server.close();
}
