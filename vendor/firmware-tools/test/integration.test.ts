// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { debugfsScript, findTool, identifyImage, locateE2fsTools, patchSystemImage, run, sha256File, verifyPatchedImage } from '../src/node.js';
import { fixture } from './fake-apk.js';

/**
 * End-to-end patch + verify on a small ext4 image built with mke2fs, shaped like the
 * stock Y2 system partition (/priv-app/MyLauncher.apk present). Skipped when e2fsprogs
 * is not installed, so CI without it still runs the pure tests.
 */
const mke2fs = await findTool('mke2fs');
const tools = await locateE2fsTools().catch(() => null);
const available = Boolean(mke2fs && tools);

describe.skipIf(!available)('patch + verify on a synthetic system image', () => {
    it('replaces the stock launcher and passes independent verification', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'myo-fw-'));
        try {
            const stock = path.join(dir, 'system.img');
            const stockLauncher = path.join(dir, 'MyLauncher.apk');
            const apk = path.join(dir, 'StudioPocket.apk');
            await writeFile(stockLauncher, Buffer.alloc(300 * 1024, 0x41));
            await writeFile(apk, fixture('signed-apksigner.apk'));
            const made = await run(mke2fs!, ['-q', '-t', 'ext4', '-L', 'system', '-b', '4096', '-O', '^has_journal', stock, '32M']);
            expect(made.code, made.stderr).toBe(0);
            await debugfsScript(tools!, stock, ['mkdir /priv-app', 'mkdir /app', 'cd /priv-app', `write ${stockLauncher} MyLauncher.apk`, 'cd /', 'write /dev/null build.prop'], true);

            const result = await patchSystemImage({ stockImage: stock, apk, out: path.join(dir, 'out.img'), workDir: path.join(dir, 'work'), tools: tools! });
            expect(result.apkSha256).toBe(await sha256File(apk));
            expect(result.fsckCode).toBeLessThanOrEqual(1);
            expect((await identifyImage(result.out)).kind).toBe('ext4');

            const report = await verifyPatchedImage({ image: result.out, expectedApkSha256: result.apkSha256, partitionSizeBytes: 0x33400000, tools: tools! });
            expect(report.problems).toEqual([]);
            expect(report.ok).toBe(true);
            expect(report.details.selinux).toContain('u:object_r:system_file:s0');

            // The stock image must be untouched.
            expect(await sha256File(stock)).toBe(result.stockSha256);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('fails verification when the readback hash differs', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'myo-fw-'));
        try {
            const stock = path.join(dir, 'system.img');
            const apk = path.join(dir, 'StudioPocket.apk');
            await writeFile(apk, fixture('signed-apksigner.apk'));
            await run(mke2fs!, ['-q', '-t', 'ext4', '-b', '4096', '-O', '^has_journal', stock, '16M']);
            await debugfsScript(tools!, stock, ['mkdir /priv-app', 'mkdir /app', 'cd /priv-app', `write ${apk} MyLauncher.apk`], true);
            const result = await patchSystemImage({ stockImage: stock, apk, out: path.join(dir, 'out.img'), workDir: path.join(dir, 'work'), tools: tools! });
            const report = await verifyPatchedImage({ image: result.out, expectedApkSha256: 'f'.repeat(64), partitionSizeBytes: 16 * 1024 * 1024, tools: tools! });
            expect(report.ok).toBe(false);
            expect(report.problems.join()).toMatch(/readback SHA-256/);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('refuses an image that does not fit the partition', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'myo-fw-'));
        try {
            const img = path.join(dir, 'big.img');
            await run(mke2fs!, ['-q', '-t', 'ext4', '-b', '4096', '-O', '^has_journal', img, '16M']);
            const report = await verifyPatchedImage({ image: img, expectedApkSha256: 'a'.repeat(64), partitionSizeBytes: 8 * 1024 * 1024, tools: tools! });
            expect(report.problems.some((p) => /exceeds ANDROID partition/.test(p))).toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe.skipIf(!available)('short vendor images', () => {
    it('pads a stock image that is shorter than its superblock says, like the 3.2.1 vendor file', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'myo-fw-'));
        try {
            const stock = path.join(dir, 'system.img');
            const apk = path.join(dir, 'StudioPocket.apk');
            await writeFile(apk, fixture('signed-apksigner.apk'));
            await run(mke2fs!, ['-q', '-t', 'ext4', '-b', '4096', '-O', '^has_journal', stock, '16M']);
            await debugfsScript(tools!, stock, ['mkdir /priv-app', 'mkdir /app', 'cd /priv-app', `write ${apk} MyLauncher.apk`], true);
            const fullSize = 16 * 1024 * 1024;
            await truncate(stock, fullSize - 5392);
            const result = await patchSystemImage({ stockImage: stock, apk, out: path.join(dir, 'out.img'), workDir: path.join(dir, 'work'), tools: tools! });
            expect(result.outBytes).toBe(fullSize);
            const report = await verifyPatchedImage({ image: result.out, expectedApkSha256: result.apkSha256, partitionSizeBytes: fullSize, tools: tools! });
            expect(report.problems).toEqual([]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
