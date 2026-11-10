// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadAsset, PLAYER_ASSETS, PLAYER_SIGNER } from '../app/player-release.mjs';
import { checkedPlan, executePlayerTask } from '../app/player-task.mjs';
import { PlayerUpdater } from '../app/player-updater.mjs';
import { mustFinishBeforeQuit } from '../app/window-lifecycle.mjs';
import { validateBackupFolder } from '../app/player-backups.mjs';

const temporary = async (fn) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-player-test-'));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};
const summary = {
  unitId: '1234567890abcdef1234567890abcdef',
  imageSha256: 'a'.repeat(64),
  firmwareVersion: '3.2.0-fm',
  version: '0.7.0',
  checklist: ['System partition only'],
};
const fixture = async (root) => {
  const calls = [],
    library = {
      inbox: path.join(root, 'Inbox'),
      busy: false,
      publish() {},
      async stopScan() {},
      async log() {},
      device: {
        async connectionStatus() {
          return { connected: false };
        },
      },
    };
  let writes = 0;
  const runner = {
    async run(input) {
      calls.push(input);
      if (input.action === 'write') {
        const saved = JSON.parse(await fs.readFile(path.join(root, 'player-update.json')));
        assert.equal(saved.pendingWrite, true, 'recovery journal must be durable before write');
        assert.ok(mustFinishBeforeQuit(library));
        writes++;
        return { ...summary, verified: true };
      }
      return summary;
    },
    cancel() {
      if (library.playerUpdate.action === 'write') throw new Error('Do not unplug');
    },
  };
  const updater = await new PlayerUpdater({
    library,
    folder: root,
    runner,
    platform: 'darwin',
    arch: 'x64',
  }).load();
  await updater.chooseFolder(root);
  return { library, updater, runner, calls, writes: () => writes };
};

test('player downloads verify bytes, reuse cache and reject corrupted, oversized and truncated downloads', () =>
  temporary(async (root) => {
    const bytes = Buffer.from('official fixture'),
      asset = {
        name: 'fixture.bin',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    let downloads = 0;
    const fetcher = async () => {
      downloads++;
      return new Response(bytes);
    };
    const file = await downloadAsset(root, asset, { fetcher });
    await downloadAsset(root, asset, { fetcher });
    assert.equal(downloads, 1);
    for (const bad of [
      Buffer.alloc(bytes.length),
      bytes.subarray(1),
      Buffer.concat([bytes, bytes]),
    ]) {
      await fs.writeFile(file, 'previous cache is corrupt');
      await assert.rejects(
        downloadAsset(root, asset, { fetcher: async () => new Response(bad) }),
        /verify|exceeded/,
      );
      assert.equal(await fs.readFile(file, 'utf8'), 'previous cache is corrupt');
      assert.ok((await fs.readdir(root)).every((f) => !f.endsWith('.part')));
    }
    await downloadAsset(root, asset, { fetcher });
    assert.deepEqual(await fs.readFile(file), bytes);
  }));

test('player write review requires exact identity, official signer/hash and unchanged prepared image', () => {
  const plan = { ...summary, expectCid: summary.unitId },
    report = {
      verification: { ok: true },
      apk: { sha256: PLAYER_ASSETS.apk.sha256, signerSha256: PLAYER_SIGNER },
    };
  assert.equal(checkedPlan(plan, report, summary).unitId, summary.unitId);
  for (const change of [
    { unitId: 'legacy', expectCid: null },
    { expectCid: 'f'.repeat(32) },
    { imageSha256: 'b'.repeat(64) },
  ])
    assert.throws(() => checkedPlan({ ...plan, ...change }, report, summary), /identity|changed/);
  for (const change of [
    { verification: { ok: false } },
    { apk: { ...report.apk, signerSha256: 'b'.repeat(64) } },
    { apk: { ...report.apk, sha256: 'b'.repeat(64) } },
  ])
    assert.throws(() => checkedPlan(plan, { ...report, ...change }), /verified official/);
});

test('updater cannot write before review or reuse confirmation and saves recovery marker before writing', () =>
  temporary(async (root) => {
    const { updater, writes, calls, library } = await fixture(root);
    assert.throws(() => updater.write('WRITE', 'invented'), /Review/);
    await updater.prepare();
    const token = updater.state.token;
    assert.throws(() => updater.write('write', token), /Review/);
    assert.equal(writes(), 0);
    await updater.write('WRITE', token);
    assert.equal(writes(), 1);
    assert.equal(calls.at(-1).expected.unitId, summary.unitId);
    assert.equal(updater.state.phase, 'complete');
    assert.equal(library.busy, false);
    assert.equal(JSON.parse(await fs.readFile(updater.file)).pendingWrite, false);
    assert.throws(() => updater.write('WRITE', token), /Review/);
  }));

test('failed player write remains recoverable across restart; retry preserves backup identity', () =>
  temporary(async (root) => {
    const { updater, runner, library } = await fixture(root);
    await updater.prepare();
    const run = runner.run;
    runner.run = async (input) => {
      if (input.action === 'write') throw new Error('Cable disconnected during write');
      return run(input);
    };
    await assert.rejects(updater.write('WRITE', updater.state.token), /Cable disconnected/);
    assert.equal(updater.state.pendingWrite, true);
    assert.equal(library.busy, false);
    const resumed = await new PlayerUpdater({
      library,
      folder: root,
      runner,
      platform: 'darwin',
      arch: 'x64',
    }).load();
    assert.equal(resumed.state.phase, 'resume');
    assert.equal(resumed.state.pendingWrite, true);
    await assert.rejects(resumed.chooseFolder(root), /pending update/);
    await assert.rejects(resumed.prepare(), /pending update/);
    await resumed.review();
    runner.run = run;
    await resumed.write('WRITE', resumed.state.token);
    assert.equal(resumed.state.phase, 'complete');
  }));

test('mounted players, active transfers and unsupported platforms cannot start a player read', () =>
  temporary(async (root) => {
    const { updater, library, calls } = await fixture(root);
    library.device.connectionStatus = async () => ({ connected: true });
    await assert.rejects(updater.prepare(), /Eject Pocket/);
    assert.equal(calls.length, 0);
    library.busy = true;
    await assert.rejects(updater.prepare(), /current operation/);
    library.busy = false;
    updater.state.supported = false;
    await assert.rejects(updater.prepare(), /Mac app/);
  }));

test('preparation failure releases operation lock and never arms writing', () =>
  temporary(async (root) => {
    const { updater, runner, library } = await fixture(root);
    runner.run = async () => {
      throw new Error('Different signing key');
    };
    await assert.rejects(updater.prepare(), /Different signing key/);
    assert.equal(library.busy, false);
    assert.equal(updater.state.token, null);
    assert.throws(() => updater.write('WRITE', null), /Review/);
    await assert.rejects(fs.stat(updater.file), { code: 'ENOENT' });
  }));

test('general folders and linked engine work folders cannot become backup workspaces', () =>
  temporary(async (root) => {
    const personal = path.join(root, 'Personal');
    await fs.mkdir(personal);
    const original = path.join(personal, 'work');
    await fs.mkdir(original);
    await fs.writeFile(path.join(original, 'notes.txt'), 'keep this');
    await assert.rejects(validateBackupFolder(personal), /empty folder|personal folders/);
    assert.equal(await fs.readFile(path.join(original, 'notes.txt'), 'utf8'), 'keep this');
    const empty = path.join(root, 'Backups');
    await fs.mkdir(empty);
    assert.equal(await validateBackupFolder(empty), empty);
    await fs.symlink(original, path.join(empty, 'work'));
    await assert.rejects(validateBackupFolder(empty), /unsafe folder/);
  }));

test('saved official update can be recovered from its backup folder after losing the app journal', () =>
  temporary(async (root) => {
    const { updater, calls, writes } = await fixture(root);
    await fs.writeFile(path.join(root, 'current-unit'), summary.unitId + '\n');
    const out = path.join(root, 'units', summary.unitId, 'upgrade', 'out');
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'build-report.json'), '{}');
    await updater.chooseFolder(root);
    assert.equal(updater.state.hasSavedUpdate, true);
    assert.equal(writes(), 0);
    await updater.review();
    assert.equal(updater.state.phase, 'prepared');
    await updater.write('WRITE', updater.state.token);
    assert.equal(updater.state.phase, 'complete');
    assert.deepEqual(
      calls.map((c) => c.action),
      ['review', 'write'],
    );
  }));

test('isolated task refuses changed plans and missing confirmation, and requires full write verification', () =>
  temporary(async (root) => {
    const firmwareDir = path.join(root, 'Backups');
    await fs.mkdir(firmwareDir);
    const input = {
      action: 'write',
      arch: 'x64',
      cache: root,
      firmwareDir,
      unitId: summary.unitId,
      expected: summary,
      confirmation: 'WRITE',
    };
    let writes = 0,
      full = 'match';
    const api = {
      inspectApkFile: async () => ({}),
      acceptApk: () => ({ ok: true, signerSha256: PLAYER_SIGNER }),
      loadUpgradePrepareReport: async () => ({
        verification: { ok: true },
        apk: { sha256: PLAYER_ASSETS.apk.sha256, signerSha256: PLAYER_SIGNER },
      }),
      planWrite: async (_platform, options) => {
        assert.equal(options.verify, 'full');
        return { ...summary, expectCid: summary.unitId, imageSizeBytes: 1024 ** 3 };
      },
      executeWrite: async (_platform, _plan, onProgress) => {
        writes++;
        onProgress({ phase: 'read', percent: 25 }, 'identity read');
        onProgress({ phase: 'write', percent: 50 }, 'write');
        onProgress({ phase: 'read', percent: 75 }, 'verification read');
        return { verification: { ok: true, full, detail: 'test readback' } };
      },
    };
    const deps = {
      api,
      platform: {},
      download: async (folder, asset) => {
        await fs.mkdir(folder, { recursive: true });
        return path.join(folder, asset.name);
      },
      extract: async () => {},
      checkTool: async () => ({ passed: true }),
      statfs: async () => ({ bavail: 100, bsize: 1024 ** 3 }),
    };
    await assert.rejects(
      executePlayerTask({ ...input, confirmation: '' }, () => {}, deps),
      /confirm/,
    );
    await assert.rejects(
      executePlayerTask(
        { ...input, expected: { ...summary, imageSha256: 'b'.repeat(64) } },
        () => {},
        deps,
      ),
      /changed/,
    );
    assert.equal(writes, 0);
    const events = [];
    assert.equal(
      (await executePlayerTask(input, (event) => events.push(event), deps)).verified,
      true,
    );
    assert.ok(events.some((e) => /Checking player identity/.test(e.label)));
    assert.ok(events.some((e) => /Reading back to verify/.test(e.label)));
    full = 'differs';
    await assert.rejects(
      executePlayerTask(input, () => {}, deps),
      /did not finish verification/,
    );
    assert.equal(writes, 2);
    full = 'match';
    const lowerSpace = { ...deps, statfs: async () => ({ bavail: 2, bsize: 1024 ** 3 }) };
    assert.equal((await executePlayerTask(input, () => {}, lowerSpace)).verified, true);
    await assert.rejects(
      executePlayerTask(input, () => {}, {
        ...deps,
        statfs: async () => ({ bavail: 1, bsize: 1024 ** 3 }),
      }),
      /verification readback/,
    );
    assert.equal(writes, 3, 'insufficient verification storage must never reach the writer');
  }));

test('failed USB reads preserve the traceback cause and connection steps without attempting a write', () =>
  temporary(async (root) => {
    const events = [];
    let writes = 0;
    const deps = {
      api: {
        inspectApkFile: async () => ({}),
        acceptApk: () => ({ ok: true, signerSha256: PLAYER_SIGNER }),
        bundledManifests: () => [],
        readDeviceSystem: async (_p, _options, cb) => {
          cb.stage('read');
          cb.mtk({ phase: 'waiting', percent: null }, 'Status: Waiting for PreLoader');
          cb.mtk({ phase: 'handshake', percent: null }, 'Device detected :)');
          cb.mtk(null, 'Traceback (most recent call last):');
          cb.mtk(null, '  File "usb/core.py", line 1');
          cb.mtk(null, 'USBError: connection was lost');
          throw new Error(
            'could not read the player (mtkclient exit 1): Traceback (most recent call last):',
          );
        },
        executeWrite: async () => {
          writes++;
        },
      },
      platform: {},
      download: async (folder, asset) => {
        await fs.mkdir(folder, { recursive: true });
        return path.join(folder, asset.name);
      },
      extract: async () => {},
      checkTool: async () => ({ passed: true }),
      statfs: async () => ({ bavail: 100, bsize: 1024 ** 3 }),
    };
    await assert.rejects(
      executePlayerTask(
        { action: 'prepare', cache: path.join(root, 'cache'), firmwareDir: root, arch: 'x64' },
        (e) => events.push(e),
        deps,
      ),
      (error) => {
        assert.match(error.message, /Nothing was written/);
        assert.match(error.message, /USBError: connection was lost/);
        assert.match(error.message, /USB reader details/);
        return true;
      },
    );
    assert.equal(writes, 0);
    assert.ok(events.some((e) => e.connectionPhase === 'waiting'));
    assert.ok(events.some((e) => e.connectionPhase === 'handshake'));
  }));

test('player failures persist in Activity and Details, clear the busy state and allow retry', () =>
  temporary(async (root) => {
    const { updater, runner, library } = await fixture(root);
    const activity = [];
    library.log = async (text, tone) => activity.push({ text, tone });
    const run = runner.run;
    runner.run = async (_input, event) => {
      event({ label: 'Waiting for player', connectionPhase: 'waiting', percent: null });
      event({ line: 'USBError: fixture read failure' });
      throw new Error('could not read the player: USBError: fixture read failure');
    };
    await assert.rejects(updater.prepare(), /could not read/);
    assert.equal(library.busy, false);
    assert.equal(updater.state.running, false);
    assert.equal(updater.state.connectionPhase, null);
    assert.equal(updater.state.token, null);
    assert.match(activity[0].text, /fixture read failure/);
    assert.equal(activity[0].tone, 'error');
    assert.match(
      await fs.readFile(path.join(root, 'player-update-details.json'), 'utf8'),
      /fixture read failure/,
    );
    const restored = await new PlayerUpdater({
      library,
      runner,
      folder: root,
      platform: 'darwin',
      arch: 'x64',
    }).load();
    assert.ok(restored.state.details.some((line) => line.includes('fixture read failure')));
    runner.run = run;
    await updater.prepare();
    assert.equal(updater.state.phase, 'prepared');
    assert.equal(updater.state.error, null);
  }));

test('reusing a backup skips device reads, verifies/prepares locally and still requires a reviewed write plan', () =>
  temporary(async (root) => {
    const unitId = summary.unitId;
    const base = path.join(root, 'units', unitId, 'upgrade');
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(path.join(root, 'current-unit'), unitId);
    await fs.writeFile(
      path.join(root, '.pocket-drop-backups.json'),
      '{"format":"pocket-drop-player-backups","version":1}\n',
    );
    await fs.writeFile(path.join(base, 'system.img'), 'read');
    await fs.writeFile(
      path.join(base, 'read-report.json'),
      JSON.stringify({
        state: 'studiopocket',
        imageSha256: 'c'.repeat(64),
        imageSizeBytes: 4,
        layout: { trustedForWrite: true },
      }),
    );
    let prepared = 0,
      checks = 0;
    const api = {
      inspectApkFile: async () => ({}),
      acceptApk: () => ({ ok: true, signerSha256: PLAYER_SIGNER }),
      readDeviceSystem: async () => {
        throw new Error('must not reread device');
      },
      prepareUpgradeFromDevice: async (_p, input) => {
        prepared++;
        assert.equal(input.unitId, unitId);
      },
      loadUpgradePrepareReport: async () => ({
        verification: { ok: true },
        apk: { sha256: PLAYER_ASSETS.apk.sha256, signerSha256: PLAYER_SIGNER },
      }),
      planWrite: async (_p, options) => {
        assert.equal(options.unitId, unitId);
        assert.equal(options.verify, 'full');
        return { ...summary, expectCid: unitId };
      },
    };
    const deps = {
      api,
      platform: {},
      extract: async () => {},
      checkTool: async () => {
        checks++;
      },
      statfs: async () => ({ bavail: 100, bsize: 1024 ** 3 }),
      download: async (folder, asset) => {
        await fs.mkdir(folder, { recursive: true });
        return path.join(folder, asset.name);
      },
    };
    const result = await executePlayerTask(
      { action: 'reuse', arch: 'x64', firmwareDir: root, unitId, cache: path.join(root, 'cache') },
      () => {},
      deps,
    );
    assert.equal(result.unitId, unitId);
    assert.equal(prepared, 1);
    assert.equal(checks, 1);
    await assert.rejects(
      executePlayerTask(
        {
          action: 'reuse',
          arch: 'x64',
          firmwareDir: root,
          unitId: 'f'.repeat(32),
          cache: path.join(root, 'cache'),
        },
        () => {},
        deps,
      ),
      /No complete backup/,
    );
    assert.equal(prepared, 1);
    await fs.mkdir(path.join(root, 'app'));
    const { updater, library, calls } = await fixture(path.join(root, 'app'));
    await updater.chooseFolder(root);
    assert.equal(updater.state.savedBackupId, unitId);
    library.device.connectionStatus = async () => {
      throw new Error('local reuse must not inspect mounted player');
    };
    await updater.prepare(true);
    assert.equal(calls.at(-1).action, 'reuse');
    assert.equal(calls.at(-1).unitId, unitId);
    assert.equal(updater.state.phase, 'prepared');
    assert.throws(() => updater.write('', updater.state.token), /type WRITE/);
  }));

test('a failed USB startup preflight stops before any player read or write', () =>
  temporary(async (root) => {
    let called = false;
    await assert.rejects(
      executePlayerTask(
        { action: 'prepare', arch: 'x64', cache: path.join(root, 'cache'), firmwareDir: root },
        () => {},
        {
          api: {
            inspectApkFile: async () => ({}),
            acceptApk: () => ({ ok: true, signerSha256: PLAYER_SIGNER }),
            readDeviceSystem: async () => {
              called = true;
            },
          },
          platform: {},
          download: async (folder, asset) => {
            await fs.mkdir(folder, { recursive: true });
            return path.join(folder, asset.name);
          },
          extract: async () => {},
          statfs: async () => ({ bavail: 100, bsize: 1024 ** 3 }),
          checkTool: async () => {
            throw new Error('The USB updater stopped during its startup check.');
          },
        },
      ),
      /startup check/,
    );
    assert.equal(called, false);
  }));
