// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identifyDeviceImage, parseBuildProp } from '../src/device.js';
import {
    DEVICE_DIR, executeWrite, InstallerError, UncheckedToolError, UnconfirmedPlayerError, WrongPlayerError, loadDeviceReadReport, loadPrepareReport, loadUpgradePrepareReport, loadUpgradeReadReport, planFlash, planWrite, prepareInstallFromDevice, prepareUpgradeFromDevice, READ_IMAGE, readDeviceSystem, readInstallRecord, recordInstall, restoreAvailableFor, UNREADABLE_SIGNER_REFUSAL, UPGRADE_DIR, UpToDateError, verifyWrite, WINDOW_IMAGE,
    type DeviceReadCallbacks, type PrepareCallbacks,
} from '../src/installer.js';
import { DownloadAgentError, downloadAgentPin, PRELOADER_NEEDED, PreloaderNeededError } from '../src/da.js';
import { measureLayout, windowForManifest } from '../src/layout.js';
import type { FirmwareManifest } from '../src/manifest.js';
import { patchSystemImage } from '../src/patch.js';
import { debugfsScript, findTool, loadManifest, locateE2fsTools, nodePlatform, run, sha256File } from '../src/node.js';
import { currentUnit, listUnits, readUnit } from '../src/units.js';
import { editApk, entryBytes, fixture, SIGNER_A, SIGNER_B } from './fake-apk.js';

/**
 * The device-sourced flow end to end on a synthetic eMMC: a file plays the user area, a
 * fake mtkclient (test/fixtures/fake-mtk.sh) serves `ro`/`wo` against it, and a synthetic
 * manifest shrinks the read window so the test stays small. The layout mirrors what the first
 * read found on the tested unit: the system ext4 sits inside the window, 0x880000 before where a
 * scatter would put it, and the next partition's ext4 starts exactly where it ends.
 */
const manifestPath = new URL('../src/manifests/y2-stock-3.2.0-fm.json', import.meta.url).pathname;
const fakeMtk = new URL('./fixtures/fake-mtk.sh', import.meta.url).pathname;
const mke2fs = await findTool('mke2fs');
const available = Boolean(mke2fs && (await locateE2fsTools().catch(() => null)));

const BUILD = '1700000001';
const OFFSET = 0x400000;           // this manifest's linearAddressOffset
const ANDROID_PHYS = 0x100000;     // scatter ANDROID physical → linear 0x500000
const CACHE_PHYS = 0x2100000;      // scatter CACHE physical → linear 0x2500000
const SYSTEM_LINEAR = 0x500000 + 0x80000; // where the unit really has it (not the scatter's)
const SYSTEM_MB = 24;
const CACHE_MB = 8;
/** What fake-mtk.sh prints as m_emmc_cid unless FAKE_MTK_CID / FAKE_MTK_NO_CID say otherwise. */
const CID = '1500aa0100a1b2c3d4e5f6012345abcd';
const OTHER_CID = '1500aa0100a1b2c3d4e5f6012345abce';
const unitOf = (fw: string, cid = CID) => path.join(fw, 'units', cid);

async function makeFs(image: string, sizeMb: number, files: Record<string, string> = {}): Promise<void> {
    const made = await run(mke2fs!, ['-q', '-t', 'ext4', '-L', 'system', '-b', '4096', '-O', '^has_journal', image, `${sizeMb}M`]);
    expect(made.code, made.stderr).toBe(0);
    const script = ['mkdir /priv-app', 'mkdir /app'];
    for (const [name, host] of Object.entries(files)) script.push(`cd /${path.dirname(name) === '.' ? '' : path.dirname(name)}`, `write "${host}" ${path.basename(name)}`);
    await debugfsScript(null, image, script, true);
}

interface Rig { dir: string; device: string; manifest: FirmwareManifest; launcher: string; apk: string; firmwareDir: string; systemImage: string }

async function buildRig(dir: string, opts: { endMarker?: boolean; launcherBytes?: number; build?: string } = {}): Promise<Rig> {
    const launcher = path.join(dir, 'MyLauncher.apk');
    const apk = path.join(dir, 'Studio Pocket.apk');
    const buildProp = path.join(dir, 'build.prop');
    await writeFile(launcher, Buffer.alloc(opts.launcherBytes ?? 200 * 1024, 0x41));
    await writeFile(apk, fixture('signed-apksigner.apk'));
    await writeFile(buildProp, [`ro.build.version.incremental=eng.build.${opts.build ?? BUILD}`, 'ro.build.display.id=Y2-v9.9.9', `ro.build.fingerprint=Y2/Y2/Y2:4.4.2/KOT49H/${opts.build ?? BUILD}:user/test-keys`, 'fmradio.driver.enable=1', '# comment', ''].join('\n'));
    const systemImage = path.join(dir, 'unit-system.img');
    await makeFs(systemImage, SYSTEM_MB, { 'priv-app/MyLauncher.apk': launcher, 'build.prop': buildProp });
    const cacheImage = path.join(dir, 'unit-cache.img');
    await makeFs(cacheImage, CACHE_MB);

    const device = path.join(dir, 'emmc user area.bin');
    const fh = await open(device, 'w');
    await fh.truncate(CACHE_PHYS + OFFSET + (CACHE_MB << 20));
    await fh.write(await readFile(systemImage), 0, SYSTEM_MB << 20, SYSTEM_LINEAR);
    if (opts.endMarker !== false) await fh.write(await readFile(cacheImage), 0, CACHE_MB << 20, SYSTEM_LINEAR + (SYSTEM_MB << 20));
    await fh.close();

    const base = await loadManifest(manifestPath);
    const manifest: FirmwareManifest = {
        ...base,
        firmwareVersion: 'synthetic',
        linearAddressOffset: `0x${OFFSET.toString(16)}`,
        platform: { ...base.platform, customBuildVersion: BUILD },
        stockLauncher: { ...base.stockLauncher, sizeBytes: 200 * 1024, sha256: await sha256File(launcher) },
        partitions: base.partitions.map((p) => p.name === 'ANDROID' ? { ...p, physicalStart: `0x${ANDROID_PHYS.toString(16)}`, size: `0x${(SYSTEM_MB << 20).toString(16)}` } : p.name === 'CACHE' ? { ...p, physicalStart: `0x${CACHE_PHYS.toString(16)}` } : p),
    };
    return { dir, device, manifest, launcher, apk, firmwareDir: path.join(dir, 'firmware dir'), systemImage };
}

const readCb = (): DeviceReadCallbacks & { stages: string[]; lines: string[]; mtkLines: string[] } => {
    const stages: string[] = []; const lines: string[] = []; const mtkLines: string[] = [];
    return { stages, lines, mtkLines, log: (l) => { lines.push(l); }, stage: (s) => { stages.push(s); }, progress: () => undefined, mtk: (_p, line) => { mtkLines.push(line); } };
};
/** Rebuilds what the engine before per-player folders left: everything flat, reports naming flat paths, no units. */
async function flattenToLegacy(fw: string): Promise<void> {
    for (const sub of ['device', 'stock', 'out']) await rename(path.join(unitOf(fw), sub), path.join(fw, sub)).catch(() => undefined);
    for (const file of [path.join(fw, 'device', 'device-identity.json'), path.join(fw, 'out', 'build-report.json')]) {
        if (await stat(file).catch(() => null)) await writeFile(file, (await readFile(file, 'utf8')).split(path.join(fw, 'units', CID)).join(fw));
    }
    const identityFile = path.join(fw, 'device', 'device-identity.json');
    const { unitId: _u, emmcCid: _c, ...oldReport } = JSON.parse(await readFile(identityFile, 'utf8'));
    await writeFile(identityFile, JSON.stringify(oldReport));
    await rm(path.join(fw, 'units'), { recursive: true });
    await rm(path.join(fw, 'current-unit'));
}

const prepCb = (): PrepareCallbacks & { stages: string[] } => { const stages: string[] = []; return { stages, log: () => undefined, stage: (s) => { stages.push(s); }, progress: () => undefined }; };

/** Reads the rig, installs Studio Pocket from rig.apk, and returns the stock read. */
async function installOn(rig: Rig): Promise<import('../src/installer.js').DeviceReadReport> {
    const read = await readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest] }, readCb());
    if (read.state !== 'stock') throw new Error(`expected a stock read, got ${read.state}`);
    await prepareInstallFromDevice(nodePlatform, { firmwareDir: rig.firmwareDir, apk: rig.apk }, prepCb());
    const outcome = await executeWrite(nodePlatform, await planWrite(nodePlatform, { firmwareDir: rig.firmwareDir, action: 'install' }));
    expect(outcome.verification.ok).toBe(true);
    return read;
}

describe('build.prop parsing', () => {
    it('reads key=value lines and ignores comments', () => {
        expect(parseBuildProp('# x\nro.a=1\n\nro.b = two=2\nbad\n')).toEqual({ 'ro.a': '1', 'ro.b': 'two=2' });
    });
});

describe.skipIf(!available)('device-sourced installer', () => {
    let dir: string;
    const envKeys = ['STUDIO_POCKET_MTK_BIN', 'FAKE_MTK_DEVICE', 'FAKE_MTK_FAIL', 'FAKE_MTK_CID', 'FAKE_MTK_NO_CID', 'FAKE_MTK_SLOW', 'FAKE_MTK_UNPATCHED', 'FAKE_MTK_NO_CONFIRM', 'FAKE_MTK_LEGACY_LINE', 'FAKE_MTK_DRAM', 'STUDIO_POCKET_DA_FILE', 'STUDIO_POCKET_DA_FILE_UNCHECKED', 'STUDIO_POCKET_PRELOADER_FILE'] as const;
    const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    /** A stand-in download agent (the real one is never fetched by the tests), given through the override. */
    let fakeDa: string;
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'myo dev-'));
        process.env.STUDIO_POCKET_MTK_BIN = fakeMtk;
        for (const k of ['FAKE_MTK_FAIL', 'FAKE_MTK_CID', 'FAKE_MTK_NO_CID', 'FAKE_MTK_SLOW', 'FAKE_MTK_UNPATCHED', 'FAKE_MTK_NO_CONFIRM', 'FAKE_MTK_LEGACY_LINE', 'FAKE_MTK_DRAM', 'STUDIO_POCKET_PRELOADER_FILE'] as const) delete process.env[k];
        fakeDa = path.join(dir, 'fake download agent.bin');
        await writeFile(fakeDa, 'not a download agent');
        process.env.STUDIO_POCKET_DA_FILE = fakeDa;
        process.env.STUDIO_POCKET_DA_FILE_UNCHECKED = '1';
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
        for (const k of envKeys) { const v = savedEnv[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    });

    it('reads, measures, identifies, prepares, writes and verifies; then restores', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const originalDevice = await sha256File(rig.device);
        expect(windowForManifest(rig.manifest)).toEqual({ start: ANDROID_PHYS, length: CACHE_PHYS + OFFSET - ANDROID_PHYS });

        const rc = readCb();
        const read = await readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest] }, rc);
        expect(read.state).toBe('stock');
        expect(rc.stages).toEqual(['read', 'measure', 'extract', 'identify', 'fsck', 'done']);
        expect(rc.mtkLines.some((l) => /Dumped offset 0x100000 with length 0x2400000 as window\.img/.test(l))).toBe(true);
        // mtkclient is handed the download agent by path (the bundles have none of their own).
        expect(rc.mtkLines).toContain(`DAconfig - Using custom loader: ${fakeDa}`);
        expect(rc.lines.some((l) => l.startsWith('warning: using the download agent at') && l.includes('STUDIO_POCKET_DA_FILE_UNCHECKED=1'))).toBe(true);
        expect(read.layout.android).toMatchObject({ start: SYSTEM_LINEAR, size: SYSTEM_MB << 20, end: SYSTEM_LINEAR + (SYSTEM_MB << 20) });
        expect(read.layout.endMarker).toMatchObject({ start: SYSTEM_LINEAR + (SYSTEM_MB << 20), size: CACHE_MB << 20 });
        expect(read.layout.trustedForWrite).toBe(true);
        expect(read.identity.manifest?.firmwareVersion).toBe('synthetic');
        expect(read.identity).toMatchObject({ build: BUILD, displayId: 'Y2-v9.9.9', fmRadio: true, problems: [] });
        expect(read.identity.launcher).toMatchObject({ path: '/priv-app/MyLauncher.apk', sizeBytes: 200 * 1024, sha256: await sha256File(rig.launcher) });
        expect(read.stockImage).toBe(path.join(unitOf(rig.firmwareDir), 'stock', 'system.img'));
        expect((await stat(read.stockImage)).size).toBe(SYSTEM_MB << 20);
        expect(read.fsckExit).toBe(0); // e2fsck -fn on the raw read
        expect((await stat(path.join(unitOf(rig.firmwareDir), DEVICE_DIR, WINDOW_IMAGE)).catch(() => null))).toBeNull();
        expect(await loadDeviceReadReport(nodePlatform, rig.firmwareDir)).toMatchObject({ stockSha256: read.stockSha256, layout: { trustedForWrite: true } });
        // The kept copy is the unit's own filesystem, as read.
        expect((await readFile(read.stockImage)).subarray(0x400 + 0x68, 0x400 + 0x78).toString('hex')).toBe(read.layout.android.uuid);

        // Prepare from the kept copy.
        const pc = prepCb();
        const report = await prepareInstallFromDevice(nodePlatform, { firmwareDir: rig.firmwareDir, apk: rig.apk, apkVersion: '0.4.0-test' }, pc);
        expect(pc.stages).toEqual(['verify-stock', 'patch', 'verify', 'done']);
        expect(report.apk).toMatchObject({ packageName: 'app.studiopocket.player', signerSha256: SIGNER_A, version: '0.4.0-test' });
        expect(report.stock).toMatchObject({ origin: 'device', systemImage: read.stockImage, systemSha256: read.stockSha256, unitUuid: read.layout.android.uuid });
        expect(report.verification.ok).toBe(true);
        expect(report.firmwareVersion).toBe('synthetic');
        expect(await loadPrepareReport(nodePlatform, rig.firmwareDir)).toMatchObject({ stock: { origin: 'device' } });
        // The package-flow planner never sees a player's image: it only looks in package/.
        await expect(planFlash(nodePlatform, { manifest: rig.manifest, firmwareDir: rig.firmwareDir, action: 'install', flashToolExe: null })).rejects.toThrow(/no prepared firmware/);

        // Write Studio Pocket.
        const install = await planWrite(nodePlatform, { firmwareDir: rig.firmwareDir, action: 'install' });
        expect(install.imagePath).toBe(report.output.path);
        // Relative, space-free paths: mtkclient splits script lines on spaces and the real app
        // data dir ("Application Support") has one, as does this test's temp dir.
        expect(install.plan.lines).toEqual([
            `ro 0x${SYSTEM_LINEAR.toString(16)} 0x400000 ../device/identity-probe.bin`,
            `wo 0x${SYSTEM_LINEAR.toString(16)} 0x${(SYSTEM_MB << 20).toString(16)} ../out/system.studiopocket.img`,
            `ro 0x${SYSTEM_LINEAR.toString(16)} 0x100000 verify-head.bin`,
            `ro 0x${(SYSTEM_LINEAR + (SYSTEM_MB << 20) - 0x100000).toString(16)} 0x100000 verify-tail.bin`,
        ]);
        expect(rig.firmwareDir).toMatch(/ /);
        expect(install.plan.dir).toBe(path.join(unitOf(rig.firmwareDir), DEVICE_DIR));
        expect(install.checklist.join(' ')).toMatch(/measured on this player/);
        expect(install.expectCid).toBe(CID);
        expect(install.checklist).toContain('The player\'s identity (…2345abcd) is checked before anything is written: the tool refuses a different player before its first read, and the session is also stopped as soon as the player reports a different id.');
        expect(install.checklist).toContain('The first and the last MiB are read back and compared with the image afterwards.');
        const outcome = await executeWrite(nodePlatform, install);
        expect(outcome.code).toBe(0);
        expect(outcome.verification).toMatchObject({ ok: true, head: 'match', tail: 'match' });
        expect(outcome.mtkLog.some((l) => /^Wrote /.test(l))).toBe(true);
        // The device now carries the patched image, byte for byte.
        const dev = await open(rig.device, 'r');
        const slice = Buffer.alloc(SYSTEM_MB << 20);
        await dev.read(slice, 0, slice.length, SYSTEM_LINEAR);
        await dev.close();
        expect(await sha256File(report.output.path)).toBe(require('node:crypto').createHash('sha256').update(slice).digest('hex'));
        expect(await verifyWrite(nodePlatform, install)).toMatchObject({ ok: true });

        await recordInstall(nodePlatform, rig.firmwareDir, { at: 'now', action: 'install', firmwareVersion: install.firmwareVersion, stockSystemSha256: read.stockSha256, imageSha256: install.imageSha256, outcome: 'verified', origin: 'device', unitUuid: install.unitUuid });
        expect((await readInstallRecord(nodePlatform, rig.firmwareDir))[0]).toMatchObject({ origin: 'device', unitUuid: read.layout.android.uuid });

        // Restore writes the kept copy back.
        const restore = await planWrite(nodePlatform, { firmwareDir: rig.firmwareDir, action: 'restore' });
        expect(restore.imagePath).toBe(read.stockImage);
        expect(restore.imageSha256).toBe(read.stockSha256);
        const restored = await executeWrite(nodePlatform, restore);
        expect(restored.verification.ok).toBe(true);
        const dev2 = await open(rig.device, 'r');
        await dev2.read(slice, 0, slice.length, SYSTEM_LINEAR);
        await dev2.close();
        expect(require('node:crypto').createHash('sha256').update(slice).digest('hex')).toBe(read.stockSha256);
        expect(await sha256File(rig.device)).toBe(originalDevice); // the kept copy is the raw read: restore puts back exactly what was there

        // A tampered image is refused at plan time; a missing read-back fails verification.
        await writeFile(report.output.path, 'tampered');
        await expect(planWrite(nodePlatform, { firmwareDir: rig.firmwareDir, action: 'install' })).rejects.toBeInstanceOf(InstallerError);
        await rm(restore.headFile);
        expect(await verifyWrite(nodePlatform, restore)).toMatchObject({ ok: false, head: 'missing' });
    });

    it('reports a failed write with the tool’s last error and no verification', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        await readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest] }, readCb());
        await prepareInstallFromDevice(nodePlatform, { firmwareDir: rig.firmwareDir, apk: rig.apk }, prepCb());
        const install = await planWrite(nodePlatform, { firmwareDir: rig.firmwareDir, action: 'install' });
        process.env.FAKE_MTK_FAIL = '1';
        const outcome = await executeWrite(nodePlatform, install);
        expect(outcome.code).not.toBe(0);
        expect(outcome.verification.ok).toBe(false);
        expect(outcome.verification.head).toBe('missing');
        expect(outcome.mtkLog.join('\n')).toMatch(/Data ack failed/);
    });

    it('refuses a layout without the end marker', async () => {
        const rig = await buildRig(dir, { endMarker: false });
        process.env.FAKE_MTK_DEVICE = rig.device;
        await expect(readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest] }, readCb())).rejects.toThrow(/cannot be written safely/);
        expect(await loadDeviceReadReport(nodePlatform, rig.firmwareDir)).toBeNull();
        await expect(planWrite(nodePlatform, { firmwareDir: rig.firmwareDir, action: 'restore' })).rejects.toThrow(/no player has been read/);
        expect(await stat(path.join(rig.firmwareDir, 'units')).catch(() => null)).toBeNull();
        // measureLayout itself reports the missing marker rather than throwing.
        const window = path.join(dir, 'w.img');
        const fh = await open(window, 'w');
        await fh.write(await readFile(rig.systemImage), 0, SYSTEM_MB << 20, 0x80000);
        await fh.close();
        expect((await measureLayout(nodePlatform, window, 0x500000)).trustedForWrite).toBe(false);
    });

    it('routes a read of a player running Studio Pocket to upgrade/ and leaves the stock copy alone', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        const first = await installOn(rig);
        const identityBefore = await readFile(path.join(unitOf(fw), DEVICE_DIR, 'device-identity.json'), 'utf8');
        const layoutBefore = await readFile(path.join(unitOf(fw), DEVICE_DIR, 'device-layout.json'), 'utf8');

        const second = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (second.state !== 'studiopocket') throw new Error(`expected an installed read, got ${second.state}`);
        expect(second.image).toBe(path.join(unitOf(fw), UPGRADE_DIR, 'system.img'));
        expect(second).toMatchObject({ unitId: CID, emmcCid: CID });
        expect(await readUnit(nodePlatform, fw, CID)).toMatchObject({ installed: true, firmwareVersion: 'synthetic' });
        expect(second.installedApkSha256).toBe(await sha256File(rig.apk));
        expect(second.layout.android).toMatchObject({ start: SYSTEM_LINEAR, size: SYSTEM_MB << 20, uuid: first.layout.android.uuid });
        expect(second.identity.manifest?.firmwareVersion).toBe('synthetic');
        expect(await sha256File(second.image)).toBe(second.imageSha256);

        // The kept original survives: same bytes, same reports, Restore still plans.
        expect(await sha256File(first.stockImage)).toBe(first.stockSha256);
        expect(await readFile(path.join(unitOf(fw), DEVICE_DIR, 'device-identity.json'), 'utf8')).toBe(identityBefore);
        expect(await readFile(path.join(unitOf(fw), DEVICE_DIR, 'device-layout.json'), 'utf8')).toBe(layoutBefore);
        expect((await planWrite(nodePlatform, { firmwareDir: fw, action: 'restore' })).imageSha256).toBe(first.stockSha256);
        expect(await stat(path.join(unitOf(fw), DEVICE_DIR, READ_IMAGE)).catch(() => null)).toBeNull();
        expect(await stat(path.join(unitOf(fw), DEVICE_DIR, WINDOW_IMAGE)).catch(() => null)).toBeNull();
        expect(await readdir(path.join(fw, 'tmp')).catch(() => [])).toEqual([]);

        expect(await loadUpgradeReadReport(nodePlatform, fw)).toMatchObject({ state: 'studiopocket', imageSha256: second.imageSha256 });
        expect(await loadDeviceReadReport(nodePlatform, fw)).toMatchObject({ state: 'stock', stockSha256: first.stockSha256 });
        expect(restoreAvailableFor(await loadDeviceReadReport(nodePlatform, fw), second)).toBe(true);
        expect(restoreAvailableFor(null, second)).toBe(false);
        const otherUnit = { ...second, layout: { ...second.layout, android: { ...second.layout.android, uuid: '0'.repeat(32) } } };
        expect(restoreAvailableFor(first, otherUnit)).toBe(false);

        // Another computer: same read, no stock copy, so no restore.
        const elsewhere = path.join(dir, 'other computer');
        const third = await readDeviceSystem(nodePlatform, { firmwareDir: elsewhere, manifests: [rig.manifest] }, readCb());
        expect(third.state).toBe('studiopocket');
        expect(await loadDeviceReadReport(nodePlatform, elsewhere)).toBeNull();
    });

    it('refuses an unknown build that carries StudioPocket.apk and keeps the stock copy', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const first = await installOn(rig);
        const other = { ...rig.manifest, platform: { ...rig.manifest.platform, customBuildVersion: '999' } };
        await expect(readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [other] }, readCb())).rejects.toThrow(/not one this tool can modify.*not a firmware this tool knows/);
        expect(await sha256File(first.stockImage)).toBe(first.stockSha256);
        expect(await loadUpgradeReadReport(nodePlatform, rig.firmwareDir)).toBeNull();
        expect(await stat(path.join(unitOf(rig.firmwareDir), DEVICE_DIR, READ_IMAGE)).catch(() => null)).toBeNull();
        expect(await readdir(path.join(rig.firmwareDir, 'tmp')).catch(() => [])).toEqual([]);
    });

    it('prepares an upgrade from the installed image, and refuses the same version', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        await installOn(rig);
        const read = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (read.state !== 'studiopocket') throw new Error('expected an installed read');

        await expect(prepareUpgradeFromDevice(nodePlatform, { firmwareDir: fw, apk: rig.apk }, prepCb())).rejects.toBeInstanceOf(UpToDateError);
        expect(await stat(path.join(unitOf(fw), UPGRADE_DIR, 'out', 'system.studiopocket.img')).catch(() => null)).toBeNull();

        const newApk = path.join(dir, 'StudioPocket 0.4.1.apk');
        await writeFile(newApk, fixture('signed-jarsigner.apk')); // same key, other bytes
        const pc = prepCb();
        const report = await prepareUpgradeFromDevice(nodePlatform, { firmwareDir: fw, apk: newApk, apkVersion: '0.4.1-test' }, pc);
        expect(pc.stages).toEqual(['verify-stock', 'patch', 'verify', 'done']);
        expect(report.verification.ok).toBe(true);
        expect(report.output.path).toBe(path.join(unitOf(fw), UPGRADE_DIR, 'out', 'system.studiopocket.img'));
        expect(report.stock).toMatchObject({ origin: 'device', systemImage: read.image, systemSha256: read.imageSha256, unitUuid: read.layout.android.uuid });
        expect(report.upgradeFrom).toEqual({ apkSha256: await sha256File(rig.apk) });
        expect(report.apk).toMatchObject({ sha256: await sha256File(newApk), version: '0.4.1-test' });
        expect(report.debugfsScript[0]).toBe('rm /priv-app/StudioPocket.apk');
        const after = await identifyDeviceImage(nodePlatform, report.output.path, [rig.manifest]);
        expect(after.installedStudioPocket?.sha256).toBe(await sha256File(newApk));
        expect(after.launcher).toBeNull();
        expect(await loadUpgradePrepareReport(nodePlatform, fw)).toMatchObject({ output: { sha256: report.output.sha256 } });
        // The install-flow report in out/ is untouched by an upgrade prepare.
        expect((await loadPrepareReport(nodePlatform, fw))?.output.path).toBe(path.join(unitOf(fw), 'out', 'system.studiopocket.img'));
    });

    it('prepare refuses an APK that is not the player package, and an upgrade signed with another key unless allowed', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        const refused = async (run: Promise<unknown>, message: string) => {
            const error = await run.then(() => null, (e: unknown) => e);
            expect(error).toBeInstanceOf(InstallerError);
            expect((error as Error).message).toBe(message);
        };
        const stockRead = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (stockRead.state !== 'stock') throw new Error('expected a stock read');

        const otherPackage = path.join(dir, 'other package.apk');
        await writeFile(otherPackage, fixture('signed-other-package.apk'));
        await refused(prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: otherPackage }, prepCb()), 'the APK is app.studiopocket.playex, not the Studio Pocket player (app.studiopocket.player)');
        const unsigned = path.join(dir, 'unsigned.apk');
        await writeFile(unsigned, fixture('tiny.apk'));
        await refused(prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: unsigned }, prepCb()), 'the APK is not a valid Android package: not signed with a v1 (JAR) signature, which Android 4.4 requires');
        const notZip = path.join(dir, 'not a zip.apk');
        await writeFile(notZip, Buffer.alloc(150 * 1024, 0x41));
        await refused(prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: notZip }, prepCb()), 'the APK is not a valid Android package: not a zip archive (no end of central directory record)');
        expect(await stat(path.join(unitOf(fw), 'out', 'system.studiopocket.img')).catch(() => null)).toBeNull();
        // The manual path refuses the same APKs.
        await expect(patchSystemImage(nodePlatform, { stockImage: rig.systemImage, apk: otherPackage, out: path.join(dir, 'manual.img'), workDir: path.join(dir, 'work') })).rejects.toThrow('the APK is app.studiopocket.playex, not the Studio Pocket player (app.studiopocket.player)');

        await prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: rig.apk }, prepCb());
        expect((await executeWrite(nodePlatform, await planWrite(nodePlatform, { firmwareDir: fw, action: 'install' }))).verification.ok).toBe(true);
        const read = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (read.state !== 'studiopocket') throw new Error('expected an installed read');

        const newSigner = path.join(dir, 'new signer.apk');
        await writeFile(newSigner, fixture('signed-other-key.apk'));
        await refused(prepareUpgradeFromDevice(nodePlatform, { firmwareDir: fw, apk: newSigner }, prepCb()), 'The new Studio Pocket is signed with a different key than the one on the player. Restore the player to its original software first, then set it up again.');
        await refused(prepareUpgradeFromDevice(nodePlatform, { firmwareDir: fw, apk: otherPackage }, prepCb()), 'the APK is app.studiopocket.playex, not the Studio Pocket player (app.studiopocket.player)');
        expect(await stat(path.join(unitOf(fw), UPGRADE_DIR, 'out', 'system.studiopocket.img')).catch(() => null)).toBeNull();
        expect(await readdir(path.join(fw, 'work')).then((names) => names.filter((n) => n.endsWith('.apk')))).toEqual([]);

        const report = await prepareUpgradeFromDevice(nodePlatform, { firmwareDir: fw, apk: newSigner, allowNewSigner: true }, prepCb());
        expect(report.verification.ok).toBe(true);
        expect(report.apk.packageName).toBe('app.studiopocket.player');
        expect(report.apk.signerSha256).toBe(SIGNER_B);
    });

    it('an upgrade whose installed APK signer cannot be read is refused for that reason, unless a new signer is allowed', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        await installOn(rig);
        const read = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (read.state !== 'studiopocket') throw new Error('expected an installed read');
        // The read image's StudioPocket.apk loses its signature block; the report follows the image.
        const unsigned = path.join(dir, 'unsigned installed.apk');
        await writeFile(unsigned, fixture('tiny.apk'));
        const image = path.join(unitOf(fw), UPGRADE_DIR, 'system.img');
        await debugfsScript(null, image, ['cd /priv-app', 'rm StudioPocket.apk', `write "${unsigned}" StudioPocket.apk`], true);
        const reportFile = path.join(unitOf(fw), UPGRADE_DIR, 'read-report.json');
        const kept = JSON.parse(await readFile(reportFile, 'utf8')) as Record<string, unknown>;
        await writeFile(reportFile, JSON.stringify({ ...kept, imageSha256: await sha256File(image) }));

        const newer = path.join(dir, 'newer.apk');
        await writeFile(newer, fixture('signed-jarsigner.apk'));
        const error = await prepareUpgradeFromDevice(nodePlatform, { firmwareDir: fw, apk: newer }, prepCb()).then(() => null, (e: unknown) => e);
        expect(error).toBeInstanceOf(InstallerError);
        expect((error as Error).message).toBe(UNREADABLE_SIGNER_REFUSAL);
        expect(UNREADABLE_SIGNER_REFUSAL).toBe('The signing key of the Studio Pocket already on the player could not be read, so the upgrade cannot be checked. Restore the player to its original software first, then set it up again, or run with --allow-new-signer from the command line.');
        expect((await prepareUpgradeFromDevice(nodePlatform, { firmwareDir: fw, apk: newer, allowNewSigner: true }, prepCb())).verification.ok).toBe(true);
    });

    it('an upgrade to an APK with two v1 signers is refused, with no image written', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        await installOn(rig);
        const read = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (read.state !== 'studiopocket') throw new Error('expected an installed read');
        // Key A's signed fixture plus key B's .SF and .RSA (byte-identical MANIFEST.MF): apksigner reports 2 signers.
        const other = fixture('signed-other-key.apk');
        const twoSigners = path.join(dir, 'two signers.apk');
        await writeFile(twoSigners, editApk(fixture('signed-apksigner.apk'), { add: [
            { name: 'META-INF/KEY-B.SF', data: entryBytes(other, 'META-INF/KEY-B.SF'), deflate: true },
            { name: 'META-INF/KEY-B.RSA', data: entryBytes(other, 'META-INF/KEY-B.RSA'), deflate: true },
        ] }));
        for (const allowNewSigner of [false, true]) {
            const error = await prepareUpgradeFromDevice(nodePlatform, { firmwareDir: fw, apk: twoSigners, allowNewSigner }, prepCb()).then(() => null, (e: unknown) => e);
            expect(error).toBeInstanceOf(InstallerError);
            expect((error as Error).message).toContain('exactly one is required');
        }
        expect(await stat(path.join(unitOf(fw), UPGRADE_DIR, 'out', 'system.studiopocket.img')).catch(() => null)).toBeNull();
    });

    it('restore refuses when the player read last is another filesystem than the kept original\'s, naming both', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        const first = await installOn(rig);
        const read = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (read.state !== 'studiopocket') throw new Error('expected an installed read');
        const reportFile = path.join(unitOf(fw), UPGRADE_DIR, 'read-report.json');
        const kept = JSON.parse(await readFile(reportFile, 'utf8')) as { layout: { android: Record<string, unknown> } };
        await writeFile(reportFile, JSON.stringify({ ...kept, layout: { ...kept.layout, android: { ...kept.layout.android, uuid: 'feedface-0000-0000-0000-000000000000' } } }));
        await expect(planWrite(nodePlatform, { firmwareDir: fw, action: 'restore' })).rejects.toThrow(
            `the player read last (player …feedface) is not the one this original belongs to (player …${first.layout.android.uuid.slice(0, 8)}); choose that player's folder or read this one first`,
        );
    });

    it('writes an upgrade at the measured offsets; restore still works afterwards', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        const stock = await installOn(rig);
        await expect(planWrite(nodePlatform, { firmwareDir: fw, action: 'upgrade' })).rejects.toThrow(/not been read/);
        const read = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (read.state !== 'studiopocket') throw new Error('expected an installed read');
        await expect(planWrite(nodePlatform, { firmwareDir: fw, action: 'upgrade' })).rejects.toThrow(/prepare it first/);
        const newApk = path.join(dir, 'new.apk');
        await writeFile(newApk, fixture('signed-jarsigner.apk'));
        const report = await prepareUpgradeFromDevice(nodePlatform, { firmwareDir: fw, apk: newApk }, prepCb());

        const a = await planWrite(nodePlatform, { firmwareDir: fw, action: 'upgrade' });
        expect(a.action).toBe('upgrade');
        expect(a.plan.lines[1]).toBe(`wo 0x${SYSTEM_LINEAR.toString(16)} 0x${(SYSTEM_MB << 20).toString(16)} ../upgrade/out/system.studiopocket.img`);
        expect(a.unitUuid).toBe(read.layout.android.uuid);
        expect(a.checklist.join(' ')).toMatch(/the upgraded Studio Pocket image/);
        const outcome = await executeWrite(nodePlatform, a);
        expect(outcome.verification).toMatchObject({ ok: true, head: 'match', tail: 'match' });
        const dev = await open(rig.device, 'r');
        const slice = Buffer.alloc(SYSTEM_MB << 20);
        await dev.read(slice, 0, slice.length, SYSTEM_LINEAR);
        await dev.close();
        expect(require('node:crypto').createHash('sha256').update(slice).digest('hex')).toBe(report.output.sha256);

        // Reading again makes the prepared upgrade stale.
        await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        await expect(planWrite(nodePlatform, { firmwareDir: fw, action: 'upgrade' })).rejects.toThrow(/not made from the last read/);

        // The original is still restorable from this computer.
        const restore = await planWrite(nodePlatform, { firmwareDir: fw, action: 'restore' });
        expect(restore.imageSha256).toBe(stock.stockSha256);
        expect((await executeWrite(nodePlatform, restore)).verification.ok).toBe(true);
        // The player runs its original again: the upgrade read and the upgrade prepared from it are forgotten.
        expect(await loadUpgradeReadReport(nodePlatform, fw)).toBeNull();
        expect(await loadUpgradePrepareReport(nodePlatform, fw)).toBeNull();
    });

    it('review I-1: a failed dump of the installed APK never routes the read into stock/', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const first = await installOn(rig);
        const identityBefore = await readFile(path.join(unitOf(rig.firmwareDir), DEVICE_DIR, 'device-identity.json'), 'utf8');
        // debugfs "dump" of our APK silently produces nothing (full or unwritable temp dir).
        const flaky = { ...nodePlatform, runE2fs: (tool: Parameters<typeof nodePlatform.runE2fs>[0], args: string[], script?: string[]) =>
            tool === 'debugfs' && args.some((a) => a.startsWith('dump /priv-app/StudioPocket.apk')) ? Promise.resolve({ code: 0, stdout: '', stderr: '' }) : nodePlatform.runE2fs(tool, args, script) };
        await expect(readDeviceSystem(flaky, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest] }, readCb())).rejects.toThrow(/already runs Studio Pocket/);
        expect(await sha256File(first.stockImage)).toBe(first.stockSha256);
        expect(await readFile(path.join(unitOf(rig.firmwareDir), DEVICE_DIR, 'device-identity.json'), 'utf8')).toBe(identityBefore);
    });

    it('review I-2/I-3/M-1: stale or unverified upgrades and a restore onto another player are refused', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        await installOn(rig);
        const read = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (read.state !== 'studiopocket') throw new Error('expected an installed read');
        const newApk = path.join(dir, 'new.apk');
        await writeFile(newApk, fixture('signed-jarsigner.apk'));
        await prepareUpgradeFromDevice(nodePlatform, { firmwareDir: fw, apk: newApk }, prepCb());

        // I-3: a build report that failed verification is never planned (install or upgrade).
        const upReportFile = path.join(unitOf(fw), UPGRADE_DIR, 'out', 'build-report.json');
        const upReport = await readFile(upReportFile, 'utf8');
        await writeFile(upReportFile, upReport.replace('"ok": true', '"ok": false'));
        await expect(planWrite(nodePlatform, { firmwareDir: fw, action: 'upgrade' })).rejects.toThrow(/failed verification/);
        await writeFile(upReportFile, upReport);
        const inReportFile = path.join(unitOf(fw), 'out', 'build-report.json');
        const inReport = await readFile(inReportFile, 'utf8');
        await writeFile(inReportFile, inReport.replace('"ok": true', '"ok": false'));
        await expect(planWrite(nodePlatform, { firmwareDir: fw, action: 'install' })).rejects.toThrow(/failed verification/);
        await writeFile(inReportFile, inReport);

        // M-1: the newest read is another player (different filesystem): Restore would write the wrong unit's original.
        const readFileUp = path.join(unitOf(fw), UPGRADE_DIR, 'read-report.json');
        const upRead = await readFile(readFileUp, 'utf8');
        await writeFile(readFileUp, upRead.split(read.layout.android.uuid).join('f'.repeat(32)));
        await expect(planWrite(nodePlatform, { firmwareDir: fw, action: 'restore' })).rejects.toThrow(/is not the one this original belongs to .*choose that player.s folder or read this one first/);
        await writeFile(readFileUp, upRead);
        expect((await planWrite(nodePlatform, { firmwareDir: fw, action: 'restore' })).action).toBe('restore');

        // I-2: once a stock player has been read, the earlier upgrade can no longer be written.
        expect((await executeWrite(nodePlatform, await planWrite(nodePlatform, { firmwareDir: fw, action: 'restore' }))).verification.ok).toBe(true);
        const stockAgain = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        expect(stockAgain.state).toBe('stock');
        await expect(planWrite(nodePlatform, { firmwareDir: fw, action: 'upgrade' })).rejects.toThrow(/not been read/);
        expect(await loadUpgradeReadReport(nodePlatform, fw)).toBeNull();
    });

    it('a read lands in units/<cid>/ with a raw stock copy and sets current-unit', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        const report = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (report.state !== 'stock') throw new Error('expected a stock read');
        expect(report.unitId).toBe(CID);
        expect(report.emmcCid).toBe(CID);
        expect(report.stockImage).toBe(path.join(fw, 'units', report.unitId, 'stock', 'system.img'));
        // Exactly the partition's bytes on the player: nothing was repaired in the kept copy.
        expect(await sha256File(report.stockImage)).toBe(await sha256File(rig.systemImage));
        expect(report.stockSha256).toBe(await sha256File(rig.systemImage));
        expect(await currentUnit(nodePlatform, fw)).toBe(report.unitId);
        const info = await readUnit(nodePlatform, fw, report.unitId);
        expect(info).toMatchObject({ unitId: CID, emmcCid: CID, fsUuid: report.layout.android.uuid, firmwareVersion: 'synthetic', installed: false });
        expect(info!.firstSeen).toBe(info!.lastSeen);
        expect(await readdir(path.join(fw, 'tmp')).catch(() => [])).toEqual([]);
        for (const flat of ['stock', 'device', 'out', 'upgrade']) expect(await stat(path.join(fw, flat)).catch(() => null)).toBeNull();
        expect(JSON.parse(await readFile(path.join(unitOf(fw), DEVICE_DIR, 'device-identity.json'), 'utf8'))).toMatchObject({ unitId: CID, emmcCid: CID });

        // A second read keeps firstSeen and moves lastSeen.
        await new Promise((r) => setTimeout(r, 5));
        await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        const again = await readUnit(nodePlatform, fw, CID);
        expect(again!.firstSeen).toBe(info!.firstSeen);
        expect(again!.lastSeen > info!.lastSeen).toBe(true);
    });

    it('a read removes what a killed read left behind, and only that', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        await mkdir(path.join(fw, 'tmp', 'read-x'), { recursive: true });
        await writeFile(path.join(fw, 'tmp', 'read-x', 'window.img'), 'stale window');
        await writeFile(path.join(fw, 'tmp', 'context.json'), 'not ours');
        await mkdir(path.join(unitOf(fw), DEVICE_DIR), { recursive: true });
        await writeFile(path.join(unitOf(fw), DEVICE_DIR, WINDOW_IMAGE), 'stale unit window');
        await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        expect(await stat(path.join(fw, 'tmp', 'read-x')).catch(() => null)).toBeNull();
        expect(await stat(path.join(unitOf(fw), DEVICE_DIR, WINDOW_IMAGE)).catch(() => null)).toBeNull();
        expect(await readdir(path.join(fw, 'tmp'))).toEqual(['context.json']);
    });

    it('a refused read leaves no unit behind and keeps the current one', async () => {
        const rigA = await buildRig(dir);
        await mkdir(path.join(dir, 'b'));
        const rigB = await buildRig(path.join(dir, 'b'));
        const fw = rigA.firmwareDir;
        process.env.FAKE_MTK_DEVICE = rigA.device;
        await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rigA.manifest] }, readCb());
        process.env.FAKE_MTK_DEVICE = rigB.device;
        process.env.FAKE_MTK_CID = OTHER_CID;
        const unknown = { ...rigA.manifest, platform: { ...rigA.manifest.platform, customBuildVersion: '999' } };
        await expect(readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [unknown] }, readCb())).rejects.toThrow(/not one this tool can modify/);
        expect(await stat(unitOf(fw, OTHER_CID)).catch(() => null)).toBeNull();
        expect(await currentUnit(nodePlatform, fw)).toBe(CID);
        expect((await listUnits(nodePlatform, fw)).map((u) => u.unitId)).toEqual([CID]);
    });

    it('a garbled current-unit reads as no player; an explicit bad id is refused', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        await writeFile(path.join(fw, 'current-unit'), '../../etc\n');
        expect(await loadDeviceReadReport(nodePlatform, fw)).toBeNull();
        expect(await loadPrepareReport(nodePlatform, fw)).toBeNull();
        expect(await loadUpgradeReadReport(nodePlatform, fw)).toBeNull();
        expect(await loadDeviceReadReport(nodePlatform, fw, CID)).not.toBeNull();
        await expect(loadDeviceReadReport(nodePlatform, fw, '../stock')).rejects.toThrow(/not a player id/);
    });

    it('two different players keep two restore copies', async () => {
        const rigA = await buildRig(dir);
        await mkdir(path.join(dir, 'b'));
        const rigB = { ...(await buildRig(path.join(dir, 'b'))), firmwareDir: rigA.firmwareDir };
        const fw = rigA.firmwareDir;
        process.env.FAKE_MTK_DEVICE = rigA.device;
        const a = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rigA.manifest] }, readCb());
        process.env.FAKE_MTK_DEVICE = rigB.device;
        process.env.FAKE_MTK_CID = OTHER_CID;
        const b = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rigB.manifest] }, readCb());
        if (a.state !== 'stock' || b.state !== 'stock') throw new Error('expected stock reads');
        expect([a.unitId, b.unitId]).toEqual([CID, OTHER_CID]);
        expect(a.stockImage).toBe(path.join(unitOf(fw, CID), 'stock', 'system.img'));
        expect(b.stockImage).toBe(path.join(unitOf(fw, OTHER_CID), 'stock', 'system.img'));
        expect(await sha256File(a.stockImage)).toBe(a.stockSha256);
        expect(await sha256File(b.stockImage)).toBe(b.stockSha256);
        expect(a.stockSha256).not.toBe(b.stockSha256);
        expect(await currentUnit(nodePlatform, fw)).toBe(OTHER_CID);
        expect((await listUnits(nodePlatform, fw)).map((u) => u.unitId)).toEqual([OTHER_CID, CID]);
        expect(await loadDeviceReadReport(nodePlatform, fw)).toMatchObject({ stockSha256: b.stockSha256 });
        expect(await loadDeviceReadReport(nodePlatform, fw, CID)).toMatchObject({ stockSha256: a.stockSha256 });
    });

    it('a read refuses a session that printed no id', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        process.env.FAKE_MTK_NO_CID = '1';
        await expect(readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest] }, readCb())).rejects.toThrow('could not identify the player (no eMMC id in the session); try again');
        expect(await stat(path.join(rig.firmwareDir, 'units')).catch(() => null)).toBeNull();
        expect(await currentUnit(nodePlatform, rig.firmwareDir)).toBeNull();
        expect(await readdir(path.join(rig.firmwareDir, 'tmp')).catch(() => [])).toEqual([]);
    });

    it('a raw read with filesystem errors still completes; the copy kept is exact', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const broken = { ...nodePlatform, runE2fs: (tool: Parameters<typeof nodePlatform.runE2fs>[0], args: string[], script?: string[]) =>
            tool === 'e2fsck' && args[0] === '-fn' ? Promise.resolve({ code: 4, stdout: '', stderr: '' }) : nodePlatform.runE2fs(tool, args, script) };
        const rc = readCb();
        const read = await readDeviceSystem(broken, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest] }, rc);
        expect(read.fsckExit).toBe(4);
        expect(rc.lines).toContain('the player’s system had filesystem errors; the copy kept is exact, the installed image will be repaired');
        if (read.state !== 'stock') throw new Error('expected a stock read');
        expect(read.stockSha256).toBe(await sha256File(rig.systemImage));
    });

    it('prepare and write use the unit; a second computer-style restore names the unit’s own copy', async () => {
        const rigA = await buildRig(dir);
        await mkdir(path.join(dir, 'b'));
        const rigB = await buildRig(path.join(dir, 'b'));
        const fw = rigA.firmwareDir;
        process.env.FAKE_MTK_DEVICE = rigA.device;
        const a = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rigA.manifest] }, readCb());
        const prepared = await prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: rigA.apk }, prepCb());
        expect(prepared.output.path).toBe(path.join(unitOf(fw), 'out', 'system.studiopocket.img'));
        expect((await planWrite(nodePlatform, { firmwareDir: fw, action: 'install' })).plan.dir).toBe(path.join(unitOf(fw), DEVICE_DIR));

        // Another player is read on the same computer; player A's restore still names A's copy.
        process.env.FAKE_MTK_DEVICE = rigB.device;
        process.env.FAKE_MTK_CID = OTHER_CID;
        const b = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rigA.manifest] }, readCb());
        if (a.state !== 'stock' || b.state !== 'stock') throw new Error('expected stock reads');
        expect((await planWrite(nodePlatform, { firmwareDir: fw, action: 'restore' })).imagePath).toBe(b.stockImage);
        const restoreA = await planWrite(nodePlatform, { firmwareDir: fw, action: 'restore', unitId: CID });
        expect(restoreA.imagePath).toBe(path.join(unitOf(fw, CID), 'stock', 'system.img'));
        expect(restoreA.imageSha256).toBe(a.stockSha256);
        expect(restoreA.plan.dir).toBe(path.join(unitOf(fw, CID), DEVICE_DIR));
        expect(restoreA.plan.lines[1]).toMatch(/ \.\.\/stock\/system\.img$/);
        // B has no prepared image of its own; A's is never offered for it.
        await expect(planWrite(nodePlatform, { firmwareDir: fw, action: 'install' })).rejects.toThrow(/prepare it first/);
        expect((await planWrite(nodePlatform, { firmwareDir: fw, action: 'install', unitId: CID })).imagePath).toBe(prepared.output.path);
        const preparedB = await prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: rigA.apk, unitId: OTHER_CID }, prepCb());
        expect(preparedB.output.path).toBe(path.join(unitOf(fw, OTHER_CID), 'out', 'system.studiopocket.img'));
    });

    it('a flat layout from before per-player folders still restores, as the legacy unit', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        const read = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (read.state !== 'stock') throw new Error('expected a stock read');
        await prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: rig.apk }, prepCb());
        await flattenToLegacy(fw);

        const restore = await planWrite(nodePlatform, { firmwareDir: fw, action: 'restore' });
        expect(restore.imagePath).toBe(path.join(fw, 'units', 'legacy', 'stock', 'system.img'));
        expect(restore.imageSha256).toBe(read.stockSha256);
        expect(await loadDeviceReadReport(nodePlatform, fw)).toMatchObject({ unitId: 'legacy', emmcCid: null });
        expect((await planWrite(nodePlatform, { firmwareDir: fw, action: 'install' })).imagePath).toBe(path.join(fw, 'units', 'legacy', 'out', 'system.studiopocket.img'));
        // A new read never adopts the legacy unit.
        const again = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        expect(again.unitId).toBe(CID);
        expect((await listUnits(nodePlatform, fw)).map((u) => u.unitId).sort()).toEqual([CID, 'legacy'].sort());
    });

    it('a write expects the unit’s id and aborts on another player with nothing written', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        const read = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        await prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: rig.apk }, prepCb());
        const install = await planWrite(nodePlatform, { firmwareDir: fw, action: 'install' });
        expect(install).toMatchObject({ unitId: CID, expectCid: CID, verify: 'edges' });
        const before = await sha256File(rig.device);
        process.env.FAKE_MTK_CID = OTHER_CID;
        process.env.FAKE_MTK_SLOW = '1';
        const error = await executeWrite(nodePlatform, install).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(WrongPlayerError);
        expect((error as WrongPlayerError).message).toBe('This is not the player this software belongs to (player …2345abcd). Nothing was written. Connect that player, or read this one first.');
        expect(error).toMatchObject({ expected: CID, connected: OTHER_CID, outcome: 'refused: wrong player' });
        expect(await sha256File(rig.device)).toBe(before);
        expect(await stat(path.join(unitOf(fw), DEVICE_DIR, 'identity-probe.bin')).catch(() => null)).toBeNull();
        // The caller records the refusal (the CLI and the desktop do; executeWrite records nothing).
        await recordInstall(nodePlatform, fw, { at: 'now', action: 'install', firmwareVersion: install.firmwareVersion, stockSystemSha256: read.state === 'stock' ? read.stockSha256 : '', imageSha256: install.imageSha256, outcome: (error as WrongPlayerError).outcome, unitId: install.unitId });
        expect((await readInstallRecord(nodePlatform, fw)).at(-1)).toMatchObject({ outcome: 'refused: wrong player', unitId: CID });
    });

    it('a session whose agent asks for a DRAM configuration stops with the preloader message; STUDIO_POCKET_PRELOADER_FILE gets past it', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        process.env.FAKE_MTK_DRAM = '1';
        const refused = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb()).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(PreloaderNeededError);
        expect((refused as Error).message).toBe(PRELOADER_NEEDED);
        expect(PRELOADER_NEEDED).toMatch(/STUDIO_POCKET_PRELOADER_FILE.*--preloader/);
        expect(await loadDeviceReadReport(nodePlatform, fw)).toBeNull();

        const preloader = path.join(dir, 'preloader y2.bin');
        await writeFile(preloader, 'preloader');
        process.env.STUDIO_POCKET_PRELOADER_FILE = preloader;
        const rc = readCb();
        expect((await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, rc)).state).toBe('stock');
        expect(rc.mtkLines).toContain(`Main - Using preloader: ${preloader}`);
        await prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: rig.apk }, prepCb());
        const install = await planWrite(nodePlatform, { firmwareDir: fw, action: 'install' });
        expect(install.plan).toMatchObject({ daFile: fakeDa, preloaderFile: preloader });

        // Without the override the write stops before its first command: nothing is written.
        delete process.env.STUDIO_POCKET_PRELOADER_FILE;
        const plain = await planWrite(nodePlatform, { firmwareDir: fw, action: 'install' });
        expect(plain.plan.preloaderFile).toBeUndefined();
        const before = await sha256File(rig.device);
        await expect(executeWrite(nodePlatform, plain)).rejects.toBeInstanceOf(PreloaderNeededError);
        expect(await sha256File(rig.device)).toBe(before);
        expect(await stat(plain.probeFile).catch(() => null)).toBeNull();

        process.env.STUDIO_POCKET_PRELOADER_FILE = path.join(dir, 'missing.bin');
        await expect(planWrite(nodePlatform, { firmwareDir: fw, action: 'install' })).rejects.toThrow(/STUDIO_POCKET_PRELOADER_FILE names .*missing\.bin, which is not a file/);
    });

    it('a DRAM request that mtkclient answered from its own folder (a venv) is not a refusal: the session carries on', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        process.env.FAKE_MTK_DRAM = 'found';
        const rc = readCb();
        expect((await readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest] }, rc)).state).toBe('stock');
        expect(rc.mtkLines.some((l) => l.startsWith('Detected preloader:'))).toBe(true);
        await prepareInstallFromDevice(nodePlatform, { firmwareDir: rig.firmwareDir, apk: rig.apk }, prepCb());
        const outcome = await executeWrite(nodePlatform, await planWrite(nodePlatform, { firmwareDir: rig.firmwareDir, action: 'install' }));
        expect(outcome.verification.ok).toBe(true);
    });

    it('without an override a read fetches the agent into <fw>/tools/da/ and hands that path to mtkclient', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        delete process.env.STUDIO_POCKET_DA_FILE;
        delete process.env.STUDIO_POCKET_DA_FILE_UNCHECKED;
        const argvFile = path.join(dir, 'argv.txt');
        process.env.FAKE_MTK_ARGV_FILE = argvFile;
        const body = Buffer.from('stand-in download agent\n');
        const requests: string[] = [];
        const server = createServer((req, res) => { requests.push(req.url ?? ''); res.writeHead(200, { 'content-length': body.length }).end(body); });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        try {
            const port = (server.address() as { port: number }).port;
            const daPin = { ...downloadAgentPin(), url: `http://127.0.0.1:${port}/${downloadAgentPin().file}`, sha256: createHash('sha256').update(body).digest('hex'), sizeBytes: body.length };
            const rc = readCb();
            expect((await readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest], daPin }, rc)).state).toBe('stock');
            const kept = path.join(rig.firmwareDir, 'tools', 'da', 'MTK_AllInOne_DA_mt6590.bin');
            expect(await readFile(kept)).toEqual(body);
            expect(await readdir(path.dirname(kept))).toEqual(['MTK_AllInOne_DA_mt6590.bin']);
            const argv = (await readFile(argvFile, 'utf8')).trim().split('\n');
            const at = argv.indexOf('--loader');
            expect(argv[at + 1]).toBe(kept);
            expect(at).toBeLessThan(argv.indexOf('script'));
            expect(rc.lines.some((l) => l.startsWith('Fetched the MediaTek download agent from upstream mtkclient'))).toBe(true);
            // A second read uses the kept file without a request.
            await readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest], daPin }, readCb());
            expect(requests).toHaveLength(1);
        } finally {
            delete process.env.FAKE_MTK_ARGV_FILE;
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    it('a read refuses a download agent override that is missing or has the wrong hash', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        delete process.env.STUDIO_POCKET_DA_FILE_UNCHECKED;
        await expect(readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest] }, readCb())).rejects.toThrow(new RegExp(`STUDIO_POCKET_DA_FILE\\) has SHA-256 [0-9a-f]{64}, not the expected ${downloadAgentPin().sha256}`));
        process.env.STUDIO_POCKET_DA_FILE = path.join(dir, 'nothing.bin');
        await expect(readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest] }, readCb())).rejects.toBeInstanceOf(DownloadAgentError);
        expect(await loadDeviceReadReport(nodePlatform, rig.firmwareDir)).toBeNull();
    });

    it('a write refuses a session that never said which player it is', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        await readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest] }, readCb());
        const restore = await planWrite(nodePlatform, { firmwareDir: rig.firmwareDir, action: 'restore' });
        const before = await sha256File(rig.device);
        process.env.FAKE_MTK_NO_CID = '1';
        const error = await executeWrite(nodePlatform, restore).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UnconfirmedPlayerError);
        expect(error).toMatchObject({ message: 'Could not confirm which player is connected; nothing was written. Restart the player and try again.', outcome: 'refused: unconfirmed player' });
        expect(await sha256File(rig.device)).toBe(before);
        // An old tool without the identity gate is refused by the capability probe; no session starts.
        process.env.FAKE_MTK_UNPATCHED = '1';
        process.env.FAKE_MTK_SLOW = '1';
        let lines: string[] = [];
        const old = await executeWrite(nodePlatform, restore, (_, line) => lines.push(line)).catch((e: unknown) => e);
        expect(old).toBeInstanceOf(UncheckedToolError);
        expect(old).toMatchObject({ sessionStarted: false, message: 'The mtkclient in use has no player identity check, so nothing was written. Rebuild the bundle (scripts/build-mtkclient.sh) or re-run scripts/setup-mtkclient-venv.sh.' });
        expect(lines.some((l) => l.startsWith('m_emmc_cid'))).toBe(false);
        expect(await sha256File(rig.device)).toBe(before);
        // A tool that passes the probe but never checks: the parent stops it on the probe read's Read progress, as on hardware.
        delete process.env.FAKE_MTK_UNPATCHED;
        process.env.FAKE_MTK_NO_CONFIRM = '1';
        lines = [];
        const unchecked = await executeWrite(nodePlatform, restore, (_, line) => lines.push(line)).catch((e: unknown) => e);
        expect(unchecked).toBeInstanceOf(UnconfirmedPlayerError);
        expect(lines.some((l) => /^Progress:.*Read:/.test(l))).toBe(true);
        expect(lines.some((l) => l.includes('Handling da commands'))).toBe(false);
        expect(await sha256File(rig.device)).toBe(before);
    });

    it('a write refuses an mtkclient without the identity check before handing it the plan, with nothing written', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        const read = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        await prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: rig.apk }, prepCb());
        const install = await planWrite(nodePlatform, { firmwareDir: fw, action: 'install' });
        const before = await sha256File(rig.device);
        process.env.FAKE_MTK_UNPATCHED = '1';
        process.env.FAKE_MTK_SLOW = '1';
        const lines: string[] = [];
        const error = await executeWrite(nodePlatform, install, (_, line) => lines.push(line)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UncheckedToolError);
        // Refused by the capability probe: the session never started, so it printed no id and read nothing.
        expect(lines.some((l) => l.startsWith('m_emmc_cid'))).toBe(false);
        expect(lines.some((l) => /^Progress:.*Read:/.test(l))).toBe(false);
        expect(error).toMatchObject({ sessionStarted: false, message: 'The mtkclient in use has no player identity check, so nothing was written. Rebuild the bundle (scripts/build-mtkclient.sh) or re-run scripts/setup-mtkclient-venv.sh.', outcome: 'refused: unchecked tool' });
        expect(await sha256File(rig.device)).toBe(before);
        expect(await stat(path.join(unitOf(fw), DEVICE_DIR, 'identity-probe.bin')).catch(() => null)).toBeNull();
        await recordInstall(nodePlatform, fw, { at: 'now', action: 'install', firmwareVersion: install.firmwareVersion, stockSystemSha256: read.state === 'stock' ? read.stockSha256 : '', imageSha256: install.imageSha256, outcome: (error as UncheckedToolError).outcome, unitId: install.unitId });
        expect((await readInstallRecord(nodePlatform, fw)).at(-1)).toMatchObject({ outcome: 'refused: unchecked tool', unitId: CID });
    });

    it('a write stops a tool that passed the probe but never confirmed the player, and says the session had started', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        await prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: rig.apk }, prepCb());
        const install = await planWrite(nodePlatform, { firmwareDir: fw, action: 'install' });
        const before = await sha256File(rig.device);
        process.env.FAKE_MTK_NO_CONFIRM = '1';
        process.env.FAKE_MTK_SLOW = '1';
        const lines: string[] = [];
        const error = await executeWrite(nodePlatform, install, (_, line) => lines.push(line)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UncheckedToolError);
        // Stopped on the probe read's Read progress: script mode prints no "Handling da commands".
        expect(lines.some((l) => /^Progress:.*Read:/.test(l))).toBe(true);
        expect(error).toMatchObject({
            sessionStarted: true,
            outcome: 'refused: unchecked tool',
            message: 'The mtkclient in use ran its plan without confirming the player; the session was stopped at its first command. Nothing should have been written, but read the player again before trusting it. Rebuild the bundle (scripts/build-mtkclient.sh) or re-run scripts/setup-mtkclient-venv.sh.',
        });
        expect(await sha256File(rig.device)).toBe(before);
    });

    it('a -4 whose last line went missing is treated as a started session (fails safe)', async () => {
        // On the desktop the last line and the result travel on different channels; a lost line must not read as "nothing was written".
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        await prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: rig.apk }, prepCb());
        const install = await planWrite(nodePlatform, { firmwareDir: fw, action: 'install' });
        const silent = { ...nodePlatform, runMtk: async () => ({ code: -4, stdout: '', stderr: '' }) };
        const error = await executeWrite(silent, install).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UncheckedToolError);
        expect(error).toMatchObject({
            sessionStarted: true,
            message: 'The mtkclient in use ran its plan without confirming the player; the session was stopped at its first command. Nothing should have been written, but read the player again before trusting it. Rebuild the bundle (scripts/build-mtkclient.sh) or re-run scripts/setup-mtkclient-venv.sh.',
        });
    });

    it('a -4 the runner flags as probe-refused is not started, even with no lines (the flag comes before the line rule)', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        await prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: rig.apk }, prepCb());
        const install = await planWrite(nodePlatform, { firmwareDir: fw, action: 'install' });
        const refused = { ...nodePlatform, runMtk: async () => ({ code: -4, probeRefused: true, stdout: '', stderr: '' }) };
        const error = await executeWrite(refused, install).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UncheckedToolError);
        expect(error).toMatchObject({
            sessionStarted: false,
            message: 'The mtkclient in use has no player identity check, so nothing was written. Rebuild the bundle (scripts/build-mtkclient.sh) or re-run scripts/setup-mtkclient-venv.sh.',
        });
    });

    it('full verification reads the whole image back and reports it', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        await prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: rig.apk }, prepCb());
        const install = await planWrite(nodePlatform, { firmwareDir: fw, action: 'install', verify: 'full' });
        expect(install.verify).toBe('full');
        expect(install.plan.lines).toHaveLength(5);
        expect(install.plan.lines[4]).toBe(`ro 0x${SYSTEM_LINEAR.toString(16)} 0x${install.imageSizeBytes.toString(16)} ../device/verify-full.img`);
        expect(install.fullFile).toBe(path.join(unitOf(fw), DEVICE_DIR, 'verify-full.img'));
        expect(install.checklist).toContain('Then the whole image is read back and compared (about six minutes more).');
        const outcome = await executeWrite(nodePlatform, install);
        expect(outcome.verification).toMatchObject({ ok: true, head: 'match', tail: 'match', full: 'match', detail: 'the whole image read back identical' });
        expect(outcome.emmcCid).toBe(CID);
        expect(await stat(install.fullFile!).catch(() => null)).toBeNull();
        expect(await stat(path.join(unitOf(fw), DEVICE_DIR, 'identity-probe.bin')).catch(() => null)).toBeNull();
    });

    it('full verification names a mismatch in the whole read-back', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        await readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest] }, readCb());
        const restore = await planWrite(nodePlatform, { firmwareDir: rig.firmwareDir, action: 'restore', verify: 'full' });
        await writeFile(restore.headFile, await readFile(restore.imagePath).then((b) => b.subarray(0, 0x100000)));
        await writeFile(restore.tailFile, await readFile(restore.imagePath).then((b) => b.subarray(b.length - 0x100000)));
        const whole = await readFile(restore.imagePath);
        whole[0x200000] ^= 0xff;
        await writeFile(restore.fullFile!, whole);
        const v = await verifyWrite(nodePlatform, restore);
        expect(v).toMatchObject({ ok: false, head: 'match', tail: 'match', full: 'differs' });
        expect(v.detail).toMatch(/^the whole image read back differs from the image/);
        // When the edges already differ, or the whole read-back is missing, the whole image was never compared.
        await rm(restore.fullFile!);
        expect(await verifyWrite(nodePlatform, restore)).toMatchObject({ ok: false, full: 'skipped' });
        await writeFile(restore.headFile, Buffer.alloc(0x100000));
        expect(await verifyWrite(nodePlatform, restore)).toMatchObject({ ok: false, head: 'differs', full: 'skipped' });
    });

    it('edges verification says what it checked', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        await readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest] }, readCb());
        const restore = await planWrite(nodePlatform, { firmwareDir: rig.firmwareDir, action: 'restore' });
        expect(restore.plan.lines).toHaveLength(4);
        expect(restore.checklist.join('\n')).not.toMatch(/whole image/);
        const outcome = await executeWrite(nodePlatform, restore);
        expect(outcome.verification).toMatchObject({ ok: true, full: 'skipped', detail: 'first and last MiB read back identical to the image' });
    });

    it('a legacy unit writes without an expectation and adopts the id afterwards', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        const read = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (read.state !== 'stock') throw new Error('expected a stock read');
        await prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: rig.apk }, prepCb());
        await flattenToLegacy(fw);

        const restore = await planWrite(nodePlatform, { firmwareDir: fw, action: 'restore' });
        expect(restore).toMatchObject({ unitId: 'legacy', expectCid: null });
        expect(restore.checklist).toContain(`This player was read before per-player backups, so its identity cannot be checked. Make sure the connected player is the one read on ${read.readAt.slice(0, 10)}.`);
        expect(restore.checklist.join(' ')).not.toMatch(/is checked before anything is written/);
        const outcome = await executeWrite(nodePlatform, restore);
        expect(outcome.verification.ok).toBe(true);
        expect(outcome.emmcCid).toBe(CID);
        expect(outcome.adoption).toBe('done');

        expect(await stat(path.join(fw, 'units', 'legacy')).catch(() => null)).toBeNull();
        expect(await currentUnit(nodePlatform, fw)).toBe(CID);
        expect(await readUnit(nodePlatform, fw, CID)).toMatchObject({ unitId: CID, emmcCid: CID, fsUuid: read.layout.android.uuid, installed: false });
        expect(await loadDeviceReadReport(nodePlatform, fw)).toMatchObject({ unitId: CID, emmcCid: CID, stockSha256: read.stockSha256 });
        expect(JSON.parse(await readFile(path.join(unitOf(fw), DEVICE_DIR, 'device-identity.json'), 'utf8'))).toMatchObject({ unitId: CID, emmcCid: CID });
        expect(await loadPrepareReport(nodePlatform, fw)).not.toBeNull();
        // From now on it verifies like any other unit.
        expect((await planWrite(nodePlatform, { firmwareDir: fw, action: 'restore' })).expectCid).toBe(CID);
    });

    it('legacy adoption merges into a unit read since, keeping its upgrade read', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        const stock = await installOn(rig);
        await flattenToLegacy(fw);
        // The player, now running Studio Pocket, is read after the change: units/<cid>/ has upgrade/ only.
        const up = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        expect(up.state).toBe('studiopocket');
        expect(await stat(path.join(unitOf(fw), 'stock')).catch(() => null)).toBeNull();
        const legacyFirstSeen = (await readUnit(nodePlatform, fw, 'legacy'))!.firstSeen;

        const restore = await planWrite(nodePlatform, { firmwareDir: fw, action: 'restore', unitId: 'legacy' });
        expect(restore.expectCid).toBeNull();
        expect((await executeWrite(nodePlatform, restore)).verification.ok).toBe(true);

        expect(await stat(path.join(fw, 'units', 'legacy')).catch(() => null)).toBeNull();
        expect(await sha256File(path.join(unitOf(fw), 'stock', 'system.img'))).toBe(stock.stockSha256);
        // upgrade/ stays; its reports go, since the player now runs its original again.
        expect(await stat(path.join(unitOf(fw), UPGRADE_DIR, 'system.img')).then((s) => s.isFile())).toBe(true);
        expect(await loadUpgradeReadReport(nodePlatform, fw, CID)).toBeNull();
        expect(await loadDeviceReadReport(nodePlatform, fw, CID)).toMatchObject({ emmcCid: CID, stockSha256: stock.stockSha256 });
        expect(await currentUnit(nodePlatform, fw)).toBe(CID);
        const info = await readUnit(nodePlatform, fw, CID);
        expect(info).toMatchObject({ emmcCid: CID, firstSeen: legacyFirstSeen });
        expect((await listUnits(nodePlatform, fw)).map((u) => u.unitId)).toEqual([CID]);
    });

    it('legacy adoption keeps the original of a unit that already has one', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        const first = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (first.state !== 'stock') throw new Error('expected a stock read');
        await flattenToLegacy(fw);
        // The player is read again after the change: units/<cid>/ gets its own original.
        const legacyStock = path.join(fw, 'units', 'legacy', 'stock', 'system.img');
        await planWrite(nodePlatform, { firmwareDir: fw, action: 'restore' }); // migrates
        const again = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (again.state !== 'stock') throw new Error('expected a stock read');
        const restore = await planWrite(nodePlatform, { firmwareDir: fw, action: 'restore', unitId: 'legacy' });
        expect((await executeWrite(nodePlatform, restore)).verification.ok).toBe(true);
        expect(await stat(legacyStock).catch(() => null)).toBeNull();
        expect(await loadDeviceReadReport(nodePlatform, fw, CID)).toMatchObject({ readAt: again.readAt, stockSha256: again.stockSha256 });
    });

    it('a CLI-style install from the legacy unit adopts the id too', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        const read = await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        if (read.state !== 'stock') throw new Error('expected a stock read');
        await prepareInstallFromDevice(nodePlatform, { firmwareDir: fw, apk: rig.apk }, prepCb());
        await flattenToLegacy(fw);
        const install = await planWrite(nodePlatform, { firmwareDir: fw, action: 'install' });
        expect(install).toMatchObject({ unitId: 'legacy', expectCid: null });
        const outcome = await executeWrite(nodePlatform, install);
        expect(outcome).toMatchObject({ verification: { ok: true }, adoption: 'done', emmcCid: CID });
        expect(await stat(path.join(fw, 'units', 'legacy')).catch(() => null)).toBeNull();
        expect(await readUnit(nodePlatform, fw, CID)).toMatchObject({ emmcCid: CID, installed: true });
        expect(await loadDeviceReadReport(nodePlatform, fw, CID)).toMatchObject({ stockSha256: read.stockSha256 });
    });

    it('a failed adoption keeps the verified write and the legacy original', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        const stock = await installOn(rig);
        await flattenToLegacy(fw);
        await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb()); // units/<cid>/ with upgrade/ only
        // The image cannot be moved into the player's folder (e.g. a file still held open on Windows).
        const stuck = { ...nodePlatform, rename: (from: string, to: string) =>
            from.includes(path.join('units', 'legacy', 'stock')) && to.includes(CID) ? Promise.reject(new Error('EPERM: operation not permitted')) : nodePlatform.rename(from, to) };
        const restore = await planWrite(stuck, { firmwareDir: fw, action: 'restore', unitId: 'legacy' });
        const outcome = await executeWrite(stuck, restore);
        expect(outcome.verification.ok).toBe(true);
        expect(outcome.adoption).toEqual({ error: 'EPERM: operation not permitted' });
        expect(await loadDeviceReadReport(nodePlatform, fw, 'legacy')).toMatchObject({ stockSha256: stock.stockSha256 });
        expect(await loadDeviceReadReport(nodePlatform, fw, CID)).toBeNull();
    });

    it('a refused full-verification write leaves no probe or read-back behind', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        await readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [rig.manifest] }, readCb());
        const restore = await planWrite(nodePlatform, { firmwareDir: rig.firmwareDir, action: 'restore', verify: 'full' });
        process.env.FAKE_MTK_CID = OTHER_CID;
        await expect(executeWrite(nodePlatform, restore)).rejects.toBeInstanceOf(WrongPlayerError);
        expect(await stat(restore.probeFile).catch(() => null)).toBeNull();
        expect(await stat(restore.fullFile!).catch(() => null)).toBeNull();
    });

    it('a CID unit expects its own id even when unit.json lost it', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const fw = rig.firmwareDir;
        await readDeviceSystem(nodePlatform, { firmwareDir: fw, manifests: [rig.manifest] }, readCb());
        const file = path.join(unitOf(fw), 'unit.json');
        await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), emmcCid: '' }));
        expect((await planWrite(nodePlatform, { firmwareDir: fw, action: 'restore' })).expectCid).toBe(CID);
    });

    it('upgrade-mode patching refuses an image without Studio Pocket', async () => {
        const rig = await buildRig(dir);
        await expect(patchSystemImage(nodePlatform, { stockImage: rig.systemImage, apk: rig.apk, out: path.join(dir, 'out.img'), workDir: path.join(dir, 'work'), mode: 'upgrade' })).rejects.toThrow(/not an installed player/);
    });

    it('recognises a unit that already runs Studio Pocket', async () => {
        const rig = await buildRig(dir);
        // what the patcher leaves behind: our APK where the stock launcher was
        await debugfsScript(null, rig.systemImage, ['rm /priv-app/MyLauncher.apk', 'cd /priv-app', `write "${rig.apk}" StudioPocket.apk`], true);
        const identity = await identifyDeviceImage(nodePlatform, rig.systemImage, [rig.manifest]);
        expect(identity.launcher).toBeNull();
        expect(identity.installedStudioPocket?.path).toBe('/priv-app/StudioPocket.apk');
        expect(identity.installedStudioPocket?.sha256).toBe(await sha256File(rig.apk));
        expect(identity.problems.join(' ')).toMatch(/already runs Studio Pocket/);
    });

    it('refuses an unknown build and a launcher that does not match the manifest', async () => {
        const rig = await buildRig(dir);
        process.env.FAKE_MTK_DEVICE = rig.device;
        const other = { ...rig.manifest, platform: { ...rig.manifest.platform, customBuildVersion: '999' } };
        await expect(readDeviceSystem(nodePlatform, { firmwareDir: rig.firmwareDir, manifests: [other] }, readCb())).rejects.toThrow(/not one this tool can modify.*not a firmware this tool knows/);

        const identity = await identifyDeviceImage(nodePlatform, rig.systemImage, [{ ...rig.manifest, stockLauncher: { ...rig.manifest.stockLauncher, sha256: 'f'.repeat(64) } }]);
        expect(identity.manifest?.firmwareVersion).toBe('synthetic');
        expect(identity.problems).toEqual([expect.stringMatching(/launcher hash .* does not match/)]);
        const wrongSize = await identifyDeviceImage(nodePlatform, rig.systemImage, [{ ...rig.manifest, stockLauncher: { ...rig.manifest.stockLauncher, sizeBytes: 1 } }]);
        expect(wrongSize.problems).toEqual([expect.stringMatching(/is 204800 B, manifest synthetic expects 1 B/)]);
        const unknown = await identifyDeviceImage(nodePlatform, rig.systemImage, [other]);
        expect(unknown.manifest).toBeNull();
        expect(unknown.launcher?.sizeBytes).toBe(200 * 1024);
        expect(unknown.problems[0]).toMatch(/build 1700000001 \(Y2-v9\.9\.9\) is not a firmware this tool knows/);
    });
});
