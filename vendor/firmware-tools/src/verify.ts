// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { debugfsQuery, dumpe2fsHeader, e2fsck } from './e2fs.js';
import { identifyImage } from './ext4.js';
import { KEY_LAYOUT, missingWakeFlags } from './keylayout.js';
import { quoteHostPath, STOCK_LAUNCHER, STOCK_LAUNCHER_ODEX, TARGET_APK, TARGET_APK_NAME } from './patch.js';
import type { FirmwarePlatform } from './platform.js';

/**
 * Independent re-open of a patched image. Mirrors Y2Player's verify_images.py (MIT; notice in
 * docs/licensing/Y2Player-MIT.txt):
 * stock launcher gone, our APK present with root:root 0644 and the system_file
 * label, byte-identical readback, clean fsck, and partition-size fit.
 */
export interface VerifyOptions {
    image: string;
    expectedApkSha256: string;
    partitionSizeBytes: number;
    log?: (line: string) => void;
}

export interface VerifyReport {
    ok: boolean;
    problems: string[];
    details: Record<string, string>;
}

export async function verifyPatchedImage(p: FirmwarePlatform, options: VerifyOptions): Promise<VerifyReport> {
    await p.locateE2fsTools();
    const log = options.log ?? (() => undefined);
    const problems: string[] = [];
    const details: Record<string, string> = {};
    const image = options.image;

    const kind = await identifyImage(p, image);
    if (kind.kind !== 'ext4') {
        return { ok: false, problems: [`not a raw ext4 image (${kind.kind})`], details };
    }
    details.fsBytes = String(kind.superblock.fsBytes);
    const fileBytes = (await p.stat(image)).size;
    details.fileBytes = String(fileBytes);
    if (fileBytes !== kind.superblock.fsBytes) {
        problems.push(`image file is ${fileBytes} B but the filesystem is ${kind.superblock.fsBytes} B; must be equal so the whole filesystem is written`);
    }
    if (kind.superblock.fsBytes > options.partitionSizeBytes) {
        problems.push(`filesystem (${kind.superblock.fsBytes} B) exceeds ANDROID partition (${options.partitionSizeBytes} B)`);
    }

    log('checking launcher replacement');
    const launcher = await debugfsQuery(p, image, `stat ${STOCK_LAUNCHER}`);
    if (/Inode:/.test(launcher)) problems.push(`${STOCK_LAUNCHER} is still present`);
    const odex = await debugfsQuery(p, image, `stat ${STOCK_LAUNCHER_ODEX}`);
    if (/Inode:/.test(odex)) problems.push(`${STOCK_LAUNCHER_ODEX} is still present`);

    const target = await debugfsQuery(p, image, `stat ${TARGET_APK}`);
    if (!/Inode:/.test(target)) {
        problems.push(`${TARGET_APK} was not installed`);
    } else {
        const mode = target.split('\n').find((l) => /Mode:/.test(l)) ?? '';
        if (!/Mode:\s+0644/.test(mode)) problems.push(`unexpected mode: ${mode.trim()}`);
        if (!/User:\s+0\b/.test(target) || !/Group:\s+0\b/.test(target)) problems.push('unexpected ownership (expected root:root)');
        details.targetStat = mode.trim();
    }

    const context = await debugfsQuery(p, image, `ea_get ${TARGET_APK} security.selinux`);
    if (!/u:object_r:system_file:s0/.test(context)) problems.push(`SELinux label missing or wrong: ${context.trim()}`);
    details.selinux = context.trim().split('\n').pop() ?? '';

    const readback = p.join(p.tmpDir(), `myo-readback-${p.uniqueId()}.apk`);
    const dumped = await debugfsQuery(p, image, `dump ${TARGET_APK} ${quoteHostPath(readback)}`);
    try {
        const readbackSha = (await p.stat(readback)).exists ? await p.sha256File(readback) : null;
        if (!readbackSha) problems.push(`could not read back ${TARGET_APK}: ${dumped.trim()}`);
        else if (readbackSha !== options.expectedApkSha256) problems.push(`readback SHA-256 ${readbackSha} != expected ${options.expectedApkSha256}`);
        details.readbackSha256 = readbackSha ?? '';
    } finally {
        await p.remove(readback).catch(() => undefined);
    }

    const listing = await debugfsQuery(p, image, 'ls -p /priv-app');
    if (/MyLauncher/.test(listing)) problems.push('MyLauncher still referenced in /priv-app');
    if (!listing.includes(`/${TARGET_APK_NAME}/`)) problems.push(`${TARGET_APK_NAME} not listed in /priv-app`);
    const appListing = await debugfsQuery(p, image, 'ls -p /app');
    if (appListing.includes(`/${TARGET_APK_NAME}/`)) problems.push('duplicate StudioPocket.apk under /app');

    // Any button wakes the screen: checked wherever the image has the Y2 key layout.
    const layout = p.join(p.tmpDir(), `myo-readback-${p.uniqueId()}.kl`);
    await debugfsQuery(p, image, `dump ${KEY_LAYOUT} ${quoteHostPath(layout)}`);
    try {
        if ((await p.stat(layout)).exists) {
            const missing = missingWakeFlags(await p.readText(layout));
            if (missing.length) problems.push(`${KEY_LAYOUT}: scan code(s) ${missing.join(', ')} do not wake the screen`);
            details.wakeKeys = missing.length ? `missing ${missing.join(', ')}` : 'all';
        }
    } finally {
        await p.remove(layout).catch(() => undefined);
    }

    log('e2fsck -fn (read-only consistency check)');
    const fsck = await e2fsck(p, image, 'check');
    if (fsck.code !== 0) problems.push(`e2fsck -fn exit ${fsck.code}`);
    details.fsck = fsck.stdout.trim().split('\n').pop() ?? '';

    const header = await dumpe2fsHeader(p, image);
    details.freeBlocks = header['Free blocks'] ?? '';
    log('hashing output image');
    details.imageSha256 = await p.sha256File(image);

    return { ok: problems.length === 0, problems, details };
}
