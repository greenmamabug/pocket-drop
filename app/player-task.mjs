// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import * as engine from '../vendor/firmware-tools/dist/index.js';
import { nodePlatform } from '../vendor/firmware-tools/dist/node.js';
import { validateBackupFolder, savedPlayerBackup } from './player-backups.mjs';
import { checkPlayerTool, playerPlatform } from './player-tool-check.mjs';
import { locatePlayerBundle } from './player-bundle.mjs';
import { PLAYER_ASSETS, PLAYER_SIGNER, PLAYER_VERSION, downloadAsset } from './player-release.mjs';

const exec = promisify(execFile);
const labels = {
  read: 'Connecting to player',
  measure: 'Checking partition layout',
  extract: 'Saving player backup',
  identify: 'Checking player compatibility',
  fsck: 'Checking the backup',
  'verify-stock': 'Checking the backup',
  patch: 'Preparing the update on your Mac',
  verify: 'Verifying the prepared update',
  'copy-stock': 'Copying the backup',
};

export function checkedPlan(plan, report, expected) {
  if (!/^[0-9a-f]{32}$/.test(plan.unitId) || plan.expectCid !== plan.unitId)
    throw new Error('This update needs a confirmed player identity. Read the player again.');
  if (
    !report?.verification?.ok ||
    report.apk?.sha256 !== PLAYER_ASSETS.apk.sha256 ||
    report.apk?.signerSha256 !== PLAYER_SIGNER
  )
    throw new Error(
      'The prepared update is not the verified official player release. Read and prepare again.',
    );
  if (expected && (expected.unitId !== plan.unitId || expected.imageSha256 !== plan.imageSha256))
    throw new Error(
      'The prepared update changed after review. Nothing was written. Review it again.',
    );
  return {
    unitId: plan.unitId,
    imageSha256: plan.imageSha256,
    firmwareVersion: plan.firmwareVersion,
    checklist: plan.checklist,
    version: PLAYER_VERSION,
  };
}

// Runs in its own process. Heavy image hashing and external tools never block Electron.
export async function executePlayerTask(
  input,
  emit = () => {},
  {
    api = engine,
    platform = nodePlatform,
    download = downloadAsset,
    extract = exec,
    statfs = fs.statfs,
    checkTool = checkPlayerTool,
    findBundle = locatePlayerBundle,
  } = {},
) {
  if (!['download', 'prepare', 'reuse', 'review', 'write'].includes(input.action))
    throw new Error('Unknown player operation.');
  if (!['x64', 'arm64'].includes(input.arch)) throw new Error('Unsupported Mac architecture.');
  const progress = (label, bytes, total) =>
    emit({
      label: label === 'Reading the player' ? 'Reading player backup' : label,
      percent: total > 0 ? Math.min(100, (bytes / total) * 100) : null,
    });
  const recentLines = [];
  const log = (line) => {
    const text = String(line)
      .replace(/\x1b\[[0-9;]*m/g, '')
      .slice(0, 1500);
    recentLines.push(text);
    if (recentLines.length > 60) recentLines.shift();
    emit({ line: text });
  };
  let writeSeen = false;
  const cb = {
    log,
    stage: (s) => {
      if (labels[s])
        emit({ label: labels[s], percent: null, connectionPhase: s === 'read' ? 'waiting' : null });
    },
    progress,
    mtk: (p, line) => {
      log(line);
      if (!p) return;
      if (p.phase === 'write') writeSeen = true;
      const label =
        p.phase === 'waiting'
          ? 'Waiting for player — press the reset pinhole with the cable connected'
          : p.phase === 'write'
            ? 'Writing player software — do not unplug'
            : p.phase === 'read'
              ? input.action === 'write'
                ? writeSeen
                  ? 'Reading back to verify — do not unplug'
                  : 'Checking player identity — do not unplug'
                : 'Reading player backup'
              : p.phase === 'handshake'
                ? 'Player detected — connecting'
                : p.phase === 'da'
                  ? 'Starting the player connection'
                  : null;
      if (label) emit({ label, percent: p.percent, connectionPhase: p.phase, missed: !!p.missed });
    },
  };
  const cache = path.join(input.cache, PLAYER_VERSION);
  if (input.firmwareDir) {
    const actual = await validateBackupFolder(input.firmwareDir);
    if (actual !== input.firmwareDir)
      throw new Error('The backup folder moved. Choose it again before updating.');
  }
  const files = {};
  emit({ label: 'Verifying updater tools', percent: null });
  const bundle = await findBundle(input.arch);
  if (bundle) log('Using the signed updater runtime inside Pocket Drop.');
  for (const key of bundle ? ['apk'] : ['apk', 'e2fs', input.arch]) {
    emit({ label: 'Checking update files', percent: null });
    files[key] = await download(cache, PLAYER_ASSETS[key], { progress });
  }
  const inspection = await api.inspectApkFile(platform, files.apk);
  const accepted = api.acceptApk(inspection);
  if (!accepted.ok || accepted.signerSha256 !== PLAYER_SIGNER)
    throw new Error(
      !accepted.ok
        ? 'This player release cannot be installed: ' + accepted.refusal + '. Nothing was written.'
        : 'The official player signing certificate did not verify. Nothing was written.',
    );
  if (input.action !== 'download') {
    if (!path.isAbsolute(input.firmwareDir)) throw new Error('Choose a backup folder on your Mac.');
    await fs.mkdir(input.firmwareDir, { recursive: true, mode: 0o700 });
    const disk = await statfs(input.firmwareDir);
    const initialSpace = ['prepare', 'reuse'].includes(input.action)
      ? 6 * 1024 ** 3
      : 128 * 1024 ** 2;
    if (Number(disk.bavail) * Number(disk.bsize) < initialSpace)
      throw new Error(
        ['prepare', 'reuse'].includes(input.action)
          ? 'Keep at least 6 GB free on the Mac before reading/preparing player backups.'
          : 'Free at least 128 MB on the Mac to review the saved update.',
      );
  }
  const tools = await fs.mkdtemp(path.join(cache, 'session-'));
  const previousTools = [process.env.STUDIO_POCKET_E2FS_DIR, process.env.STUDIO_POCKET_MTK_BIN];
  try {
    const e2fs = bundle?.e2fs ?? path.join(tools, 'e2fs'),
      mtk = bundle?.mtk ?? path.join(tools, 'mtk');
    if (!bundle) {
      await fs.mkdir(e2fs);
      await fs.mkdir(mtk);
      // Only fixed, hash-checked upstream archives are ever extracted, into a private fresh directory.
      await extract('/usr/bin/tar', ['-xzf', files.e2fs, '--no-same-owner', '-C', e2fs]);
      await extract('/usr/bin/tar', ['-xzf', files[input.arch], '--no-same-owner', '-C', mtk]);
    }
    process.env.STUDIO_POCKET_E2FS_DIR = e2fs;
    process.env.STUDIO_POCKET_MTK_BIN = path.join(mtk, 'mtk');
    emit({ label: 'Checking the USB updater — older Macs may need a moment', percent: null });
    await checkTool(path.join(mtk, 'mtk'), tools, { log });
    const p = playerPlatform(platform, log);
    if (input.action === 'download') {
      if (input.firmwareDir) {
        emit({ label: 'Checking the download agent', percent: null });
        await api.ensureDownloadAgent(p, input.firmwareDir, log);
      }
      return {
        version: PLAYER_VERSION,
        toolIdentityVerified: true,
        toolSource: bundle ? 'bundled' : 'downloaded',
        runtimePath: mtk,
      };
    }
    if (['prepare', 'reuse'].includes(input.action)) {
      const saved = input.action === 'reuse' ? await savedPlayerBackup(input.firmwareDir) : null;
      if (input.action === 'reuse' && (!saved || saved.unitId !== input.unitId))
        throw new Error(
          'No complete backup for this player was found. Choose its backup folder or make a new backup.',
        );
      const read =
        input.action === 'reuse'
          ? { state: 'studiopocket', unitId: saved.unitId }
          : await api.readDeviceSystem(
              p,
              { firmwareDir: input.firmwareDir, manifests: api.bundledManifests() },
              cb,
            );
      if (read.state !== 'studiopocket')
        throw new Error(
          'This player does not already run Studio Pocket. This wizard updates existing installations only.',
        );
      if (!/^[0-9a-f]{32}$/.test(read.unitId))
        throw new Error('The player identity could not be confirmed. Nothing was written.');
      try {
        await api.prepareUpgradeFromDevice(
          p,
          {
            firmwareDir: input.firmwareDir,
            unitId: read.unitId,
            apk: files.apk,
            apkVersion: PLAYER_VERSION,
          },
          cb,
        );
      } catch (error) {
        if (error instanceof api.UpToDateError) return { current: true, unitId: read.unitId };
        throw error;
      }
      input = { ...input, unitId: read.unitId };
    }
    const report = await api.loadUpgradePrepareReport(p, input.firmwareDir, input.unitId);
    const plan = await api.planWrite(
      p,
      { firmwareDir: input.firmwareDir, unitId: input.unitId, action: 'upgrade', verify: 'full' },
      log,
    );
    const summary = checkedPlan(plan, report, input.expected);
    if (input.action !== 'write') return summary;
    if (input.confirmation !== 'WRITE' || !input.expected)
      throw new Error('Review and confirm the prepared update first. Nothing was written.');
    const currentDisk = await statfs(input.firmwareDir);
    if (!Number.isSafeInteger(plan.imageSizeBytes) || plan.imageSizeBytes <= 0)
      throw new Error('The prepared image size is not valid. Nothing was written.');
    if (
      Number(currentDisk.bavail) * Number(currentDisk.bsize) <
      plan.imageSizeBytes + 256 * 1024 ** 2
    )
      throw new Error(
        'Not enough Mac storage for the full verification readback. Free space and retry the prepared update; nothing was written.',
      );
    emit({
      label: 'Waiting for player — press the reset pinhole with the cable connected',
      connectionPhase: 'waiting',
      percent: null,
    });
    const outcome = await api.executeWrite(p, plan, cb.mtk);
    if (!outcome.verification.ok || outcome.verification.full !== 'match')
      throw new Error(
        'The update did not finish verification. Keep the cable connected and retry the prepared update. ' +
          outcome.verification.detail,
      );
    return { ...summary, verified: true };
  } catch (error) {
    if (
      /could not read the player|mtkclient exit|Traceback/i.test(error.message) &&
      recentLines.length
    ) {
      const cause = [...recentLines]
        .reverse()
        .find((line) => /\b\w*(?:Error|Exception):/.test(line));
      throw new Error(
        (input.action === 'prepare'
          ? 'The player backup could not finish. Nothing was written to the player. '
          : '') +
          (cause ? cause + '\n\n' : '') +
          error.message +
          '\n\nUSB reader details:\n' +
          recentLines.slice(-35).join('\n'),
      );
    }
    throw error;
  } finally {
    for (const [index, key] of ['STUDIO_POCKET_E2FS_DIR', 'STUDIO_POCKET_MTK_BIN'].entries()) {
      if (previousTools[index] === undefined) delete process.env[key];
      else process.env[key] = previousTools[index];
    }
    await fs.rm(tools, { recursive: true, force: true });
  }
}
