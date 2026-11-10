import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-studio-desktop-')),
  folder = path.join(root, 'Downloads', 'Pocket Drop Inbox', 'Story');
await fs.mkdir(path.join(folder, 'audio'), { recursive: true });
await fs.mkdir(path.join(folder, 'icons'));
for (const [n, fixture] of [
  ['01', 'tone-c5.mp3'],
  ['02', 'tone-g5.mp3'],
])
  await fs.copyFile(
    'vendor/library-format/fixtures/audio/' + fixture,
    path.join(folder, 'audio', n + '.mp3'),
  );
await sharp({ create: { width: 16, height: 16, channels: 3, background: '#66aa88' } })
  .png()
  .toFile(path.join(folder, 'icons', 'one.png'));
const cover = path.join(root, 'cover.png');
await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aaccff' } })
  .png()
  .toFile(cover);
await fs.writeFile(
  path.join(folder, 'metadata.json'),
  JSON.stringify({
    format: 'myo-studio-archive',
    title: 'Desktop story',
    tracks: [
      { index: 0, title: 'Opening', audio: 'audio/01.mp3', icon: 'icons/one.png' },
      { index: 1, title: 'Ending', audio: 'audio/02.mp3' },
    ],
  }),
);
const old = new Date(Date.now() - 10000);
await fs.utimes(folder, old, old);
const application = await electron.launch({
  args: ['--no-sandbox', '--disable-gpu', 'scripts/desktop-entry.mjs'],
  env: {
    ...process.env,
    DISPLAY: process.env.DISPLAY ?? ':100',
    POCKET_DROP_TEST_ROOT: root,
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
  },
  timeout: 30000,
});
try {
  const page = await application.firstWindow(),
    errors = [];
  if (process.env.POCKET_PLAYER_TOOL_CHECK === '1') {
    if (process.env.POCKET_PLAYER_ASSET_CACHE)
      await fs.cp(process.env.POCKET_PLAYER_ASSET_CACHE, path.join(root, 'player-download-test'), {
        recursive: true,
      });
    const result = await application.evaluate(
      async (_electron, cache) => globalThis.pocketTestPlayerDownload(cache),
      path.join(root, 'player-download-test'),
    );
    assert.equal(result.version, '0.7.0');
  }
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByText('Desktop story', { exact: true }).waitFor();
  await page.locator('.audio-open').click();
  await page.locator('#audio-editor').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#editor-tags').count(), 0);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-track-metrics]')].every(
      (e) => !e.textContent.includes('Length'),
    ),
  );
  assert.ok((await page.locator('[data-track-metrics]').first().innerText()).includes(' · '));
  await page.locator('[data-track-play]').first().click();
  await page.waitForFunction(() => document.getElementById('track-player').duration > 0);
  const src = await page.locator('#track-player').getAttribute('src');
  assert.ok(src.startsWith('pocket-media://preview/'));
  const range = await page.evaluate(async (src) => {
    const r = await fetch(src, { headers: { Range: 'bytes=0-9' } });
    return { status: r.status, size: (await r.arrayBuffer()).byteLength };
  }, src);
  assert.deepEqual(range, { status: 206, size: 10 });
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, cover);
  await page.locator('#change-cover').click();
  await page.waitForFunction(() =>
    document.getElementById('editor-cover').getAttribute('src')?.startsWith('pocket-media:'),
  );
  await page.locator('#cover-mode').selectOption('fill');
  await page.locator('#editor-title').fill('Edited desktop story');
  await page.locator('[data-track-up="audio/02.mp3"]').click();
  await page.locator('[data-track-icon="audio/02.mp3"]').selectOption('icons/one.png');
  await page.locator('#editor-save-only').click();
  await page.waitForFunction(
    () => document.getElementById('editor-save-status').textContent === 'Saved',
  );
  let catalog = JSON.parse(
    await fs.readFile(path.join(root, 'support', 'studio', 'catalog-v1.json'), 'utf8'),
  );
  const item = Object.values(catalog.items)[0];
  assert.equal(item.edits.title, 'Edited desktop story');
  assert.equal(item.edits.tracks[0].key, 'audio/02.mp3');
  assert.ok(item.coverData.startsWith('data:image/png'));
  await page.screenshot({ path: 'release/Audio-details-440.png' });
  const rendered = (await fs.readdir(path.join(root, 'support', 'studio', 'rendered-artwork')))[0];
  const image = await sharp(
    path.join(root, 'support', 'studio', 'rendered-artwork', rendered),
  ).metadata();
  assert.equal(image.width, 540);
  assert.equal(image.height, 856);
  await page.locator('#editor-close').click();
  await page.locator('[data-page=collections]').click();
  await page.locator('#new-collection').click();
  await page.locator('#collection-name').fill('Bedtime');
  await page.locator('[data-member]').check();
  await page.locator('#collection-picture-change').click();
  await page.locator('#collection-picture-preview').waitFor({ state: 'visible' });
  await page.locator('#collection-look').selectOption('image');
  assert.equal(
    await page
      .locator('#collection-picture-preview')
      .evaluate((e) => getComputedStyle(e).borderRadius),
    '50%',
  );
  await page.locator('#collection-save').click();
  await page.locator('#collection-dialog').waitFor({ state: 'hidden' });
  catalog = JSON.parse(
    await fs.readFile(path.join(root, 'support', 'studio', 'catalog-v1.json'), 'utf8'),
  );
  assert.equal(catalog.groups[0].playlists.length, 1);
  const pictured = JSON.parse(
    await fs.readFile(path.join(root, 'support', 'studio', 'catalog-v1.json'), 'utf8'),
  );
  assert.ok(Object.values(pictured.collectionPictures)[0].thumbnail.startsWith('data:image/png'));
  assert.equal(pictured.groups[0].display, 'image');
  assert.match(pictured.groups[0].image, /^groups\/.+-image-.+\.png$/);
  const portrait = Object.values(pictured.collectionPictures)[0].imageRef.replace('asset:', '');
  const portraitInfo = await sharp(
    path.join(root, 'support', 'studio', 'artwork', portrait),
  ).metadata();
  assert.equal(portraitInfo.width, 252);
  assert.equal(portraitInfo.height, 400);
  await page.locator('[data-page=books]').click();
  await page.locator('.audio-open').click();
  assert.equal(await page.locator('#editor-title').inputValue(), 'Edited desktop story');
  await page.locator('[data-track-delete="audio/01.mp3"]').click();
  await page.locator('#editor-save-only').click();
  await page.waitForFunction(
    () => document.getElementById('editor-save-status').textContent === 'Saved',
  );
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
  });
  await page.locator('#trash-original-tracks').click();
  await page.waitForFunction(() => !document.getElementById('trash-original-tracks').disabled);
  await fs.stat(path.join(folder, 'audio', '01.mp3'));
  const trash = path.join(root, 'test-trash');
  await fs.mkdir(trash);
  await application.evaluate(({ dialog, shell }, trash) => {
    dialog.showMessageBox = async () => ({ response: 1 });
    shell.trashItem = (file) => globalThis.pocketTestTrash(file, trash);
  }, trash);
  await page.locator('#trash-original-tracks').click();
  await page.waitForFunction(() => !document.getElementById('audio-editor').open);
  assert.equal(await fs.stat(path.join(folder, 'audio', '01.mp3')).catch(() => null), null);
  assert.ok(await fs.stat(path.join(trash, '01.mp3')));

  const numbered = path.join(root, 'Downloads', 'Pocket Drop Inbox', 'Numbered archive');
  await fs.mkdir(path.join(numbered, 'audio_files'), { recursive: true });
  await fs.mkdir(path.join(numbered, 'images'));
  await fs.copyFile(
    'vendor/library-format/fixtures/audio/tone-c5.mp3',
    path.join(numbered, 'audio_files', '1 - Numbered opening.mp3'),
  );
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#88aacc' } })
    .png()
    .toFile(path.join(numbered, 'images', '1.png'));
  await fs.copyFile(cover, path.join(numbered, 'images', 'cover_image.png'));
  await fs.writeFile(path.join(numbered, 'card.txt'), 'ignore this');
  await fs.writeFile(path.join(numbered, 'tracks.txt'), 'ignore this too');
  await fs.utimes(numbered, old, old);
  await page.evaluate(() => window.pocket.invoke('refresh'));
  await page.evaluate(() => window.pocket.invoke('refresh'));
  await page.getByText('Numbered archive', { exact: true }).click();
  await page.locator('#audio-editor').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-track-icon]').inputValue(), 'images/1.png');
  assert.ok((await page.locator('#editor-cover').getAttribute('src')).startsWith('data:image/png'));
  assert.equal(await page.locator('#editor-save-only').innerText(), 'Save');
  assert.equal(await page.locator('#editor-save').innerText(), 'Save and close');
  await page.locator('#editor-save-only').click();
  await page.waitForFunction(
    () => document.getElementById('editor-save-status').textContent === 'Saved',
  );
  await page.locator('#editor-close').click();
  const numberedKey = (await page.evaluate(() => window.pocket.invoke('state'))).rows.find(
    (r) => r.title === 'Numbered archive',
  ).key;
  await page.evaluate((key) => window.pocket.invoke('prepareAudio', [key]), numberedKey);
  await page.waitForFunction(() =>
    ['Audio is ready to sync', 'Audio preparation needs attention'].includes(
      document.getElementById('preparation-title').textContent,
    ),
  );
  const preparedState = await page.evaluate(() => window.pocket.invoke('state'));
  assert.equal(preparedState.preparation.phase, 'Audio is ready to sync');
  assert.equal((await sharp(path.join(numbered, 'images', '1.png')).metadata()).width, 64);
  await page.evaluate(() => window.pocket.invoke('updateRepository', ''));
  assert.equal(
    (await page.evaluate(() => window.pocket.invoke('checkUpdates'))).status,
    'unconfigured',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: real Electron editor IPC, audio preview and HTTP-style range seeking, native image selection/crop, persistent names/icon reassignment, collection saving, editor reopen confirmed/cancelled moves of originals to Trash, and numbered archive artwork normalization.',
  );
} finally {
  await application.close();
  await fs.rm(root, { recursive: true, force: true });
}
