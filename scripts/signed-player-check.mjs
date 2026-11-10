// Read-only check of an installed/release executable's isolated updater helper.
// Invoke with the SIGNED app's executable and ELECTRON_RUN_AS_NODE=1. Never opens USB.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const main = process.argv[2];
if (!main || !path.isAbsolute(main)) throw new Error('Pass the packaged main file.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Pocket Drop signed startup '));
const worker = pathToFileURL(path.join(path.dirname(main), 'player-runner.mjs')).href;
const { PlayerRunner } = await import(worker);
console.log('Actual executable:', process.execPath);
console.log(
  'Runtime:',
  JSON.stringify({
    electron: process.versions.electron,
    node: process.versions.node,
    arch: process.arch,
    system: os.release(),
  }),
);
try {
  const result = await new PlayerRunner().run(
    { action: 'download', cache: root, arch: 'x64' },
    (event) => {
      if (event.line || event.label) console.log(event.line || event.label);
    },
  );
  assert.equal(result.toolIdentityVerified, true);
  console.log(
    'PASS: signed executable and packaged isolated helper verified native identity capability without a player.',
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
