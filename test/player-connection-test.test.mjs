// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readOnlyPlan, testPlayerConnection } from '../app/player-connection-test.mjs';
import { executePlayerTask } from '../app/player-task.mjs';
import { PLAYER_ASSETS, PLAYER_SIGNER } from '../app/player-release.mjs';
import { parseMtkLine } from '../vendor/firmware-tools/dist/index.js';
const unitId = '1234567890abcdef1234567890abcdef';
const report = {
  unitId,
  state: 'studiopocket',
  layout: { trustedForWrite: true, android: { start: 0x5d00000, size: 0x33400000 } },
};
const temp = async (fn) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket read only '));
  try {
    await fn(folder);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
};
test('diagnostic constructs only read commands within a saved measured system partition', () => {
  const plan = readOnlyPlan(report, unitId, '/tmp/work', '/tmp/da.bin');
  assert.equal(plan.lines.length, 32);
  assert.ok(
    plan.lines.every((line) => /^ro 0x5d00000 0x400000 connection-read-\d+\.bin$/.test(line)),
  );
  assert.ok(plan.lines.every((line) => !line.startsWith('wo')));
  for (const broken of [
    null,
    { ...report, unitId: 'f'.repeat(32) },
    { ...report, layout: { ...report.layout, trustedForWrite: false } },
    { ...report, layout: { ...report.layout, android: { start: -1, size: 1 } } },
  ])
    assert.throws(
      () => readOnlyPlan(broken, unitId, '/tmp/work', '/tmp/da'),
      /player-specific backup/,
    );
});
test('read-only diagnostic preserves the backup and requires identity, completion and all received file sizes', () =>
  temp(async (folder) => {
    const backup = path.join(folder, 'original.img');
    await fs.writeFile(backup, 'keep this exact original');
    const events = [];
    const api = {
      loadUpgradeReadReport: async () => report,
      ensureDownloadAgent: async () => '/tmp/da.bin',
      parseMtkLine: (line) =>
        line.startsWith('Dumped offset')
          ? { phase: 'done', percent: 100 }
          : { phase: 'read', percent: 50 },
    };
    const platform = {
      runMtk: async (plan, onLog, options) => {
        assert.equal(options.expectCid, unitId);
        for (let i = 0; i < plan.lines.length; i++) {
          assert.match(plan.lines[i], /^ro /);
          await fs.writeFile(plan.files[i], '');
          await fs.truncate(plan.files[i], plan.length);
          onLog('Read: 50%');
          onLog('Dumped offset 0x5d00000');
        }
        return { code: 0 };
      },
    };
    const options = {
      platform,
      api,
      firmwareDir: folder,
      folder,
      unitId,
      log: () => {},
      emit: (e) => events.push(e),
      count: 2,
    };
    const result = await testPlayerConnection(options);
    assert.equal(result.bytesRead, 8 * 1024 ** 2);
    assert.equal(result.completedReads, 2);
    assert.equal(await fs.readFile(backup, 'utf8'), 'keep this exact original');
    assert.ok(events.some((e) => /reads/.test(e.label)));
    await assert.rejects(
      testPlayerConnection({ ...options, platform: { runMtk: async () => ({ code: 1 }) } }),
      /No firmware was written by this test/,
    );
    await assert.rejects(
      testPlayerConnection({
        ...options,
        platform: {
          runMtk: async (_plan, onLog) => {
            onLog('Dumped offset');
            onLog('Dumped offset');
            return { code: 0 };
          },
        },
        count: 3,
      }),
      /did not finish/,
    );
    await assert.rejects(
      testPlayerConnection({
        ...options,
        platform: {
          runMtk: async (plan, onLog) => {
            await fs.truncate(plan.files[0], plan.length - 1);
            onLog('Dumped offset');
            onLog('Dumped offset');
            return { code: 0 };
          },
        },
      }),
      /received incomplete data/,
    );
  }));

test('connection task uses the bundled runtime and real progress parser without entering backup or write operations', () =>
  temp(async (root) => {
    const backup = path.join(root, 'backup'),
      cache = path.join(root, 'cache');
    await fs.mkdir(backup);
    const downloads = [],
      reads = [],
      events = [];
    let session;
    const previous = process.env.STUDIO_POCKET_MTK_BIN;
    const result = await executePlayerTask(
      { action: 'connection-test', arch: 'x64', unitId, firmwareDir: backup, cache },
      (event) => events.push(event),
      {
        findBundle: async () => ({ mtk: '/signed/mtk', e2fs: '/signed/e2fs' }),
        download: async (folder, asset) => {
          downloads.push(asset.name);
          await fs.mkdir(folder, { recursive: true });
          return '/fixture.apk';
        },
        statfs: async () => ({ bavail: 1024 ** 3, bsize: 1 }),
        checkTool: async (file) => assert.equal(file, '/signed/mtk/mtk'),
        extract: async () => assert.fail('must not extract another runtime'),
        api: {
          inspectApkFile: async () => ({}),
          acceptApk: () => ({ ok: true, signerSha256: PLAYER_SIGNER }),
          loadUpgradeReadReport: async () => report,
          ensureDownloadAgent: async () => '/fixture-da.bin',
          parseMtkLine,
          readDeviceSystem: async () => assert.fail('must not replace the backup'),
          prepareUpgradeFromDevice: async () => assert.fail('must not prepare another image'),
          planWrite: async () => assert.fail('must not plan a firmware write'),
          executeWrite: async () => assert.fail('must not write firmware'),
        },
        platform: {
          runMtk: async (plan, onLog, options) => {
            session = plan.dir;
            assert.equal(options.expectCid, unitId);
            assert.equal(process.env.STUDIO_POCKET_MTK_BIN, '/signed/mtk/mtk');
            for (let i = 0; i < plan.files.length; i++) {
              reads.push(plan.lines[i]);
              await fs.writeFile(plan.files[i], '');
              await fs.truncate(plan.files[i], plan.length);
              onLog('Progress: |██████████| 100.0% Read: (0x400000/0x400000), 1 MB/s');
              onLog(`Dumped offset 0x5d00000 with length 0x400000 as connection-read-${i}.bin.`);
            }
            return { code: 0 };
          },
        },
      },
    );
    assert.deepEqual(downloads, [PLAYER_ASSETS.apk.name]);
    assert.equal(reads.length, 32);
    assert.ok(reads.every((line) => line.startsWith('ro ')));
    assert.equal(result.bytesRead, 128 * 1024 ** 2);
    assert.equal(result.completedReads, 32);
    assert.ok(events.some((event) => event.connectionPhase === 'read'));
    assert.ok(Number.isFinite(result.transferMs));
    await assert.rejects(fs.stat(session), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(backup), []);
    assert.equal(process.env.STUDIO_POCKET_MTK_BIN, previous);
  }));
