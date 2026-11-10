// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { debugfsScript, findTool, loadManifest, locateE2fsTools, nodePlatform, run, sha256File } from '../src/node.js';
import { InstallerError, loadPackagePrepareReport, loadPrepareReport, planFlash, prepareInstall, readInstallRecord, recordInstall, StockError, type PrepareCallbacks } from '../src/installer.js';
import { identifyStock } from '../src/stock.js';
import type { FirmwareManifest } from '../src/manifest.js';
import { fixture, SIGNER_A } from './fake-apk.js';

/**
 * The installer engine on a synthetic stock package: a small ext4 "system.img" with the stock
 * launcher in /priv-app, the real scatter layout, and a manifest whose hashes match. The work
 * directory has a space in its name, like the real app data dir on macOS.
 */
const manifestPath = new URL('../src/manifests/y2-stock-3.2.1.json', import.meta.url).pathname;
const scatterFixture = new URL('./fixtures/y2-3.2.1-layout.scatter.txt', import.meta.url).pathname;
const mke2fs = await findTool('mke2fs');
const available = Boolean(mke2fs && (await locateE2fsTools().catch(() => null)));

const cb = (): PrepareCallbacks & { stages: string[]; lines: string[] } => {
    const stages: string[] = []; const lines: string[] = [];
    return { stages, lines, log: (l) => { lines.push(l); }, stage: (s) => { stages.push(s); }, progress: () => undefined };
};

async function syntheticStock(dir: string): Promise<{ manifest: FirmwareManifest; stockDir: string; apk: string }> {
    const stockDir = path.join(dir, 'stock src');
    await run('mkdir', ['-p', stockDir]);
    const image = path.join(stockDir, 'system.img');
    const launcher = path.join(dir, 'MyLauncher.apk');
    const apk = path.join(dir, 'Studio Pocket.apk');
    await writeFile(launcher, Buffer.alloc(200 * 1024, 0x41));
    await writeFile(apk, fixture('signed-apksigner.apk'));
    const made = await run(mke2fs!, ['-q', '-t', 'ext4', '-L', 'system', '-b', '4096', '-O', '^has_journal', image, '24M']);
    expect(made.code, made.stderr).toBe(0);
    await debugfsScript(null, image, ['mkdir /priv-app', 'mkdir /app', 'cd /priv-app', `write "${launcher}" MyLauncher.apk`], true);
    const scatterPath = path.join(stockDir, 'MT6582_Android_scatter.txt');
    await writeFile(scatterPath, await readFile(scatterFixture));
    const base = await loadManifest(manifestPath);
    const manifest: FirmwareManifest = {
        ...base,
        files: {
            ...base.files,
            'system.img': { ...base.files['system.img']!, sha256: await sha256File(image), sizeBytes: (await stat(image)).size },
            'MT6582_Android_scatter.txt': { ...base.files['MT6582_Android_scatter.txt']!, sha256: await sha256File(scatterPath) },
        },
    };
    return { manifest, stockDir, apk };
}

describe.skipIf(!available)('installer engine', () => {
    it('prepares, verifies, plans install and restore, and records', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'myo inst-'));
        try {
            const { manifest, stockDir, apk } = await syntheticStock(dir);
            const firmwareDir = path.join(dir, 'firmware dir');
            const c = cb();
            const report = await prepareInstall(nodePlatform, { source: stockDir, manifest, apk, apkVersion: '0.1.0-test', firmwareDir }, c);
            expect(c.stages).toEqual(['verify-stock', 'copy-stock', 'patch', 'verify', 'done']);
            expect(report.verification.ok).toBe(true);
            expect(report.verification.problems).toEqual([]);
            expect(report.apk.sha256).toBe(await sha256File(apk));
            expect(report.apk).toMatchObject({ packageName: 'app.studiopocket.player', signerSha256: SIGNER_A });
            expect(report.debugfsScript[2]).toBe(`write "${apk}" StudioPocket.apk`);
            // Stock copy kept for restore, untouched.
            expect(await sha256File(report.stock.systemImage)).toBe(manifest.files['system.img']!.sha256);
            // The package flow lives in package/, apart from every player's folder.
            expect(report.stock.systemImage).toBe(path.join(firmwareDir, 'package', 'stock', 'system.img'));
            expect(report.output.path).toBe(path.join(firmwareDir, 'package', 'out', 'system.studiopocket.img'));
            expect(await loadPackagePrepareReport(nodePlatform, firmwareDir)).toMatchObject({ output: { sha256: report.output.sha256 } });
            expect(await loadPrepareReport(nodePlatform, firmwareDir)).toBeNull();

            const toolDir = path.join(dir, 'SP Flash Tool');
            await run('mkdir', ['-p', toolDir]);
            await writeFile(path.join(toolDir, 'MTK_AllInOne_DA.bin'), 'da');
            const exe = path.join(toolDir, 'flash_tool.exe');
            await writeFile(exe, '');
            const install = await planFlash(nodePlatform, { manifest, firmwareDir, action: 'install', flashToolExe: exe });
            expect(install.imagePath).toBe(report.output.path);
            expect(install.downloadAgentPresent).toBe(true);
            expect(install.xmlPath).toBe(path.join(firmwareDir, 'package', 'out', 'spflash-install-android-only.xml'));
            const xml = await readFile(install.xmlPath, 'utf8');
            expect(xml).toContain('<download-only>');
            expect(xml).toContain('<rom index="16" enable="true">');
            expect(xml).toContain(install.imagePath);
            expect(xml).not.toMatch(/format/i);
            expect(xml).toContain(path.join(toolDir, 'MTK_AllInOne_DA.bin'));

            const restore = await planFlash(nodePlatform, { manifest, firmwareDir, action: 'restore', flashToolExe: null });
            expect(restore.imagePath).toBe(report.stock.systemImage);
            expect(restore.imageSha256).toBe(manifest.files['system.img']!.sha256);
            expect(restore.plan.checklist[2]).toMatch(/untouched stock system\.img/);
            // Upgrades go through mtkclient only; the package flow must not read 'upgrade' as a restore.
            await expect(planFlash(nodePlatform, { manifest, firmwareDir, action: 'upgrade', flashToolExe: null })).rejects.toThrow(/install and restore only/);
            expect(await readFile(restore.xmlPath, 'utf8')).toContain('[SP Flash Tool folder]');

            await recordInstall(nodePlatform, firmwareDir, { at: 'now', action: 'install', firmwareVersion: '3.2.1', stockSystemSha256: report.stock.systemSha256, imageSha256: report.output.sha256, outcome: 'exit 0' });
            expect((await readInstallRecord(nodePlatform, firmwareDir)).map((e) => e.action)).toEqual(['install']);

            // A changed image is refused at plan time.
            await writeFile(report.output.path, 'tampered');
            await expect(planFlash(nodePlatform, { manifest, firmwareDir, action: 'install', flashToolExe: exe })).rejects.toBeInstanceOf(InstallerError);
            await expect(planFlash(nodePlatform, { manifest, firmwareDir, action: 'install', flashToolExe: path.join(toolDir, 'other.exe') })).rejects.toThrow(/no prepared firmware|flash_tool\.exe/);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('identifies a package by hash among several manifests', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'myo-inst-'));
        try {
            const { manifest, stockDir } = await syntheticStock(dir);
            const other = { ...manifest, firmwareVersion: 'other', files: { ...manifest.files, 'system.img': { ...manifest.files['system.img']!, sha256: 'e'.repeat(64) } } };
            const hit = await identifyStock(nodePlatform, stockDir, [other, manifest]);
            expect(hit?.manifest.firmwareVersion).toBe(manifest.firmwareVersion);
            expect(hit?.kind).toBe('dir');
            expect(await identifyStock(nodePlatform, stockDir, [other])).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('refuses a stock package whose hashes do not match the manifest', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'myo-inst-'));
        try {
            const { manifest, stockDir, apk } = await syntheticStock(dir);
            const wrong = { ...manifest, files: { ...manifest.files, 'system.img': { ...manifest.files['system.img']!, sha256: 'f'.repeat(64) } } };
            await expect(prepareInstall(nodePlatform, { source: stockDir, manifest: wrong, apk, firmwareDir: path.join(dir, 'fw') }, cb())).rejects.toBeInstanceOf(StockError);
            expect(await loadPackagePrepareReport(nodePlatform, path.join(dir, 'fw'))).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
