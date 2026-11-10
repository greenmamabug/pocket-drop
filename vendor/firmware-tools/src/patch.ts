// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { acceptApk, inspectApkFile } from './apk.js';
import { debugfsQuery, debugfsScript, e2fsck, ToolError } from './e2fs.js';
import { addWakeFlags, buildKeyLayoutScript, KEY_LAYOUT } from './keylayout.js';
import { identifyImage } from './ext4.js';
import type { FirmwarePlatform } from './platform.js';

/**
 * Replacing the stock launcher in an ext4 system image, offline, with debugfs.
 * This is the Y2Player method (MIT, tools/firmware/integrate_launcher.py; notice in
 * docs/licensing/Y2Player-MIT.txt) ported
 * to a pure function plus one runner. Only the system partition image is touched;
 * boot, preloader, recovery and NVRAM are never read or written by this code.
 */
export const STOCK_LAUNCHER = '/priv-app/MyLauncher.apk';
export const STOCK_LAUNCHER_ODEX = '/priv-app/MyLauncher.odex';
export const TARGET_APK_NAME = 'StudioPocket.apk';
export const TARGET_APK = `/priv-app/${TARGET_APK_NAME}`;
/** Matches every stock file in /system/priv-app; includes the trailing NUL the kernel stores. */
export const SELINUX_CONTEXT = 'u:object_r:system_file:s0\0';
export const APK_MODE = '0100644';
/** install: replace the stock launcher; upgrade: replace an installed StudioPocket.apk. */
export type PatchMode = 'install' | 'upgrade';

export interface PatchPlan {
    /** Absolute path of the APK on the host, written into the image. */
    apkPath: string;
    /** Absolute path of a file containing SELINUX_CONTEXT bytes. */
    contextPath: string;
    /** Whether MyLauncher.odex exists in the image (stock 3.2.1 has none). */
    removeOdex: boolean;
    /** Default 'install'. */
    mode?: PatchMode;
}

/**
 * Host paths inside a debugfs script are double-quoted: debugfs' parser splits on
 * whitespace but honours quotes, and the desktop's data directory contains a space.
 */
export function quoteHostPath(value: string): string {
    if (/["\n\r]/.test(value)) throw new ToolError(`path must not contain quotes or newlines (debugfs limitation): ${value}`);
    return `"${value}"`;
}

/** The exact debugfs command sequence. Pure, so tests can pin it. */
export function buildDebugfsScript(plan: PatchPlan): string[] {
    const upgrade = plan.mode === 'upgrade';
    const commands = [upgrade ? `rm ${TARGET_APK}` : `rm ${STOCK_LAUNCHER}`];
    if (!upgrade && plan.removeOdex) commands.push(`rm ${STOCK_LAUNCHER_ODEX}`);
    commands.push(
        'cd /priv-app',
        `write ${quoteHostPath(plan.apkPath)} ${TARGET_APK_NAME}`,
        `sif ${TARGET_APK_NAME} mode ${APK_MODE}`,
        `sif ${TARGET_APK_NAME} uid 0`,
        `sif ${TARGET_APK_NAME} gid 0`,
        `ea_set -f ${quoteHostPath(plan.contextPath)} ${TARGET_APK_NAME} security.selinux`,
    );
    return commands;
}

export interface PatchOptions {
    stockImage: string;
    apk: string;
    out: string;
    workDir: string;
    /** Default 'install'. */
    mode?: PatchMode;
    log?: (line: string) => void;
    onProgress?: (e: { stage: 'copy' | 'hash'; bytes: number; total: number }) => void;
}

export interface PatchResult {
    out: string;
    outBytes: number;
    stockSha256: string;
    apkSha256: string;
    outSha256: string;
    /** From the APK inspection (./apk.ts) that cleared it for writing. */
    apkPackageName: string;
    apkSignerSha256: string;
    fsckCode: number;
    script: string[];
    /** Scan codes that gained WAKE in the key layout (./keylayout.ts); empty when nothing needed changing. */
    wakeKeysAdded: number[];
}

export async function patchSystemImage(p: FirmwarePlatform, options: PatchOptions): Promise<PatchResult> {
    const log = options.log ?? (() => undefined);
    await p.locateE2fsTools();
    const apkPath = options.apk;
    const out = options.out;
    quoteHostPath(apkPath);

    const kind = await identifyImage(p, options.stockImage);
    if (kind.kind !== 'ext4') {
        throw new ToolError(`stock image must be a raw ext4 image (got ${kind.kind}); convert sparse images with simg2img first`);
    }
    const apkStat = await p.stat(apkPath);
    if (!apkStat.exists || apkStat.isDir) throw new ToolError(`APK missing: ${apkPath}`);
    const apk = acceptApk(await inspectApkFile(p, apkPath));
    if (!apk.ok) throw new ToolError(apk.refusal);
    const mode = options.mode ?? 'install';
    let reclaimed = 0;
    if (mode === 'upgrade') {
        const installed = (await debugfsScript(p, options.stockImage, [`stat ${TARGET_APK}`], false)).stdout;
        const size = installed.match(/Size:\s+(\d+)/);
        if (!/Inode:/.test(installed) || !size) throw new ToolError(`${TARGET_APK} is not in the image; this is not an installed player`);
        reclaimed = Number(size[1]);
    }
    if (apkStat.size > kind.superblock.freeBlocks * kind.superblock.blockSize + reclaimed) {
        throw new ToolError('APK is larger than the free space in the system image');
    }

    await p.mkdirp(options.workDir);
    await p.mkdirp(p.dirname(out));
    const contextPath = p.join(options.workDir, 'selinux-system_file.ctx');
    quoteHostPath(contextPath);
    await p.writeText(contextPath, SELINUX_CONTEXT);

    log(`copy ${options.stockImage} -> ${out}`);
    const stockSize = (await p.stat(options.stockImage)).size;
    await p.copyFile(options.stockImage, out, (bytes) => options.onProgress?.({ stage: 'copy', bytes, total: stockSize }));
    // The vendor's 3.2.1 system.img is 5,392 bytes shorter than its own superblock says
    // (859,826,928 vs 209,920 x 4096). e2fsck aborts on that mismatch, so pad the copy with
    // zeros to exactly the filesystem size. The partition is the same size, so it still fits.
    const copied = await p.stat(out);
    if (copied.size < kind.superblock.fsBytes) {
        log(`pad ${copied.size} -> ${kind.superblock.fsBytes} bytes (zeros)`);
        await p.truncate(out, kind.superblock.fsBytes);
    } else if (copied.size > kind.superblock.fsBytes) {
        throw new ToolError(`stock image (${copied.size} B) is larger than its filesystem (${kind.superblock.fsBytes} B)`);
    }

    const odexPresent = mode === 'install' && /Inode:/.test((await debugfsScript(p, out, [`stat ${STOCK_LAUNCHER_ODEX}`], false)).stdout);
    const script = buildDebugfsScript({ apkPath, contextPath, removeOdex: odexPresent, mode });
    log(`debugfs -w (${script.length} commands)`);
    const result = await debugfsScript(p, out, script, true);
    if (result.code !== 0) throw new ToolError(`debugfs failed (${result.code}): ${result.stderr || result.stdout}`);
    const failure = result.stdout.split('\n').find((line) => /(not found|No such|Could not|rm: )/.test(line) && !/odex/.test(line));
    if (failure) throw new ToolError(`debugfs reported: ${failure.trim()}`);

    const wakeKeysAdded = await applyWakeKeys(p, out, options.workDir, contextPath, log);

    log('e2fsck -fy (reconcile bitmaps and counts)');
    const fsck = await e2fsck(p, out, 'fix');
    if (fsck.code > 1) throw new ToolError(`e2fsck -fy exit ${fsck.code}: ${fsck.stdout}${fsck.stderr}`);

    log('hashing stock, APK and output');
    const stockSha256 = await p.sha256File(options.stockImage);
    const apkSha256 = await p.sha256File(apkPath);
    const outSize = (await p.stat(out)).size;
    const outSha256 = await p.sha256File(out, (bytes) => options.onProgress?.({ stage: 'hash', bytes, total: outSize }));
    return { out, outBytes: outSize, stockSha256, apkSha256, outSha256, apkPackageName: apk.packageName, apkSignerSha256: apk.signerSha256, fsckCode: fsck.code, script, wakeKeysAdded };
}

/**
 * Pressing a button wakes the screen (./keylayout.ts): the image's key layout gains WAKE on the
 * arrow, centre and back buttons (not the ring, which turns too easily by accident). Install and upgrade both run it; an image that already has them
 * (an upgrade of a player set up with this version) is left alone, and an image without the
 * file keeps its stock keys, with a log line.
 */
async function applyWakeKeys(p: FirmwarePlatform, image: string, workDir: string, contextPath: string, log: (line: string) => void): Promise<number[]> {
    const current = p.join(workDir, 'mtk-kpd.kl.read');
    const next = p.join(workDir, 'mtk-kpd.kl');
    await p.remove(current).catch(() => undefined);
    await debugfsQuery(p, image, `dump ${KEY_LAYOUT} ${quoteHostPath(current)}`);
    if (!(await p.stat(current)).exists) {
        log(`${KEY_LAYOUT} is not in this image: the keys keep their stock wake behaviour`);
        return [];
    }
    const edit = addWakeFlags(await p.readText(current));
    if (edit.untouched.length) log(`key layout: no plain line for scan code(s) ${edit.untouched.join(', ')}; left as they are`);
    if (!edit.changed.length) {
        log('key layout: every button already wakes the screen');
        return [];
    }
    await p.writeText(next, edit.text);
    const result = await debugfsScript(p, image, buildKeyLayoutScript(quoteHostPath(next), quoteHostPath(contextPath)), true);
    if (result.code !== 0) throw new ToolError(`debugfs failed on the key layout (${result.code}): ${result.stderr || result.stdout}`);
    const failure = result.stdout.split('\n').find((line) => /(not found|No such|Could not|rm: )/.test(line));
    if (failure) throw new ToolError(`debugfs reported on the key layout: ${failure.trim()}`);
    log(`key layout: WAKE added for scan code(s) ${edit.changed.join(', ')}`);
    return edit.changed;
}
