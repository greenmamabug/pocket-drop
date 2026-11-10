// Run with the packaged Electron executable and ELECTRON_RUN_AS_NODE=1; opens no device.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const resources = process.argv[2];
assert.ok(resources && path.isAbsolute(resources));
const root = path.join(resources, 'app.asar');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(pkg.dependencies['@studio-pocket/firmware-tools'], undefined);
for (const folder of [path.join(root, 'app'), path.join(root, 'ui')])
  assert.ok((await fs.readdir(folder)).every((name) => !name.startsWith('player-')));
for (const file of [
  path.join(resources, 'firmware-tools'),
  path.join(root, 'vendor', 'firmware-tools'),
  path.join(root, 'node_modules', '@studio-pocket', 'firmware-tools'),
])
  assert.equal(
    await fs.stat(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }),
    null,
  );
const html = await fs.readFile(path.join(root, 'ui', 'index.html'), 'utf8');
assert.doesNotMatch(
  html,
  /id="(?:manage-player|player-update-dialog|player-connection-guide|view-player-progress)"/,
);
assert.match(html, /id="yoto-connect"/);
for (const file of ['icon-ipc.mjs', 'icon-catalog.mjs', 'yoto-account.mjs'])
  await import(pathToFileURL(path.join(root, 'app', file)).href);
console.log(
  'PASS: packaged icon services import; firmware controls, helpers, dependency and native runtime are absent. No device opened.',
);
