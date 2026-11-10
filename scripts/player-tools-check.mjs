// Read-only release smoke test. Never opens a player or invokes a flash plan.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { PlayerRunner } from '../app/player-runner.mjs';
import { PlayerUpdater } from '../app/player-updater.mjs';
import { PLAYER_ASSETS, PLAYER_VERSION, verifyAsset } from '../app/player-release.mjs';
import { probeTool } from '../vendor/firmware-tools/dist/node.js';
const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-player-tools-'));
try {
  const updater = new PlayerUpdater({ library: { publish() {} }, folder: root });
  updater.journal = { test: 'recovery marker flush' };
  await updater.saveJournal();
  assert.equal(JSON.parse(await fs.readFile(updater.file)).test, 'recovery marker flush');
  const result = await new PlayerRunner().run(
    { action: 'download', cache: root, arch: process.arch },
    () => {},
  );
  assert.equal(result.version, PLAYER_VERSION);
  if (process.platform === 'darwin') {
    const dir = path.join(root, PLAYER_VERSION),
      e2fs = path.join(root, 'e2fs'),
      mtk = path.join(root, 'mtk');
    await fs.mkdir(e2fs);
    await fs.mkdir(mtk);
    for (const [key, out] of [
      ['e2fs', e2fs],
      [process.arch, mtk],
    ]) {
      const archive = await verifyAsset(
        path.join(dir, PLAYER_ASSETS[key].name),
        PLAYER_ASSETS[key],
      );
      await exec('/usr/bin/tar', ['-xzf', archive, '--no-same-owner', '-C', out]);
    }
    for (const name of ['debugfs', 'e2fsck', 'dumpe2fs']) {
      const output = await exec(path.join(e2fs, name), ['-V']);
      assert.match(output.stdout + output.stderr, /1\.47\.4/);
    }
    assert.equal(await probeTool(path.join(mtk, 'mtk'), root, process.env, () => {}), true);
  }
  console.log(
    'PASS: isolated helper downloads the exact release, verifies real APK signatures and hashes; native Mac tools pass the no-device identity capability probe. No player opened or written.',
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
