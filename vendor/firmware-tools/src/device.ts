// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { debugfsQuery } from './e2fs.js';
import { TARGET_APK } from './patch.js';
import { identifyImage } from './ext4.js';
import type { FirmwareManifest } from './manifest.js';
import { quoteHostPath, STOCK_LAUNCHER } from './patch.js';
import type { FirmwarePlatform } from './platform.js';

/** Prefix of the identification problem raised for an image that already carries Studio Pocket. */
export const ALREADY_RUNS_STUDIO_POCKET = 'this player already runs Studio Pocket';

/**
 * Identifies a system image read from a player: which firmware build it is, and whether the
 * stock launcher we are about to replace is the one the manifest expects. This replaces the
 * zip-hash identification of the download path: the unit's own filesystem is a different
 * ext4 generation of the same build, so only content can be compared.
 */
export interface DeviceIdentity {
    buildIncremental: string;
    /** ro.build.version.incremental without the `eng.build.` prefix: the manifest's customBuildVersion. */
    build: string;
    fingerprint: string;
    displayId: string;
    fmRadio: boolean;
    fsUuid: string;
    /** Present when the image already carries Studio Pocket (an installed or upgraded unit). */
    installedStudioPocket: { path: string; sizeBytes: number; sha256: string } | null;
    launcher: { path: string; sizeBytes: number; sha256: string } | null;
    manifest: FirmwareManifest | null;
    problems: string[];
}

export function parseBuildProp(text: string): Record<string, string> {
    const props: Record<string, string> = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return props;
}

const ENG_PREFIX = /^eng\.build\./;

/** The launcher path inside the image (manifests record it with the /system mount prefix). */
export function launcherImagePath(manifest: FirmwareManifest | null): string {
    const recorded = manifest?.stockLauncher.path;
    return recorded ? recorded.replace(/^\/system(?=\/)/, '') : STOCK_LAUNCHER;
}

export async function identifyDeviceImage(p: FirmwarePlatform, image: string, manifests: FirmwareManifest[]): Promise<DeviceIdentity> {
    const problems: string[] = [];
    const kind = await identifyImage(p, image);
    if (kind.kind !== 'ext4') {
        return { buildIncremental: '', build: '', fingerprint: '', displayId: '', fmRadio: false, fsUuid: '', installedStudioPocket: null, launcher: null, manifest: null, problems: [`not a raw ext4 image (${kind.kind})`] };
    }
    const props = parseBuildProp(await debugfsQuery(p, image, 'cat /build.prop'));
    const buildIncremental = props['ro.build.version.incremental'] ?? '';
    if (!buildIncremental) problems.push('build.prop not found or has no ro.build.version.incremental');
    const build = buildIncremental.replace(ENG_PREFIX, '');
    const manifest = manifests.find((m) => m.platform.customBuildVersion === build) ?? null;
    if (!manifest && build) {
        problems.push(`build ${build} (${props['ro.build.display.id'] ?? '?'}) is not a firmware this tool knows (known: ${manifests.map((m) => `${m.firmwareVersion}=${m.platform.customBuildVersion ?? '?'}`).join(', ')})`);
    }

    const launcherPath = launcherImagePath(manifest);
    let launcher: DeviceIdentity['launcher'] = null;
    const stat = await debugfsQuery(p, image, `stat ${launcherPath}`);
    const sizeMatch = stat.match(/Size:\s+(\d+)/);
    let installedStudioPocket: DeviceIdentity['installedStudioPocket'] = null;
    if (!/Inode:/.test(stat) || !sizeMatch) {
        // A unit that already runs Studio Pocket has our APK where the stock launcher was.
        const ours = await debugfsQuery(p, image, `stat ${TARGET_APK}`);
        if (/Inode:/.test(ours)) {
            const dumped = p.join(p.tmpDir(), `myo-installed-${p.uniqueId()}.apk`);
            try {
                await debugfsQuery(p, image, `dump ${TARGET_APK} ${quoteHostPath(dumped)}`);
                const info = await p.stat(dumped);
                if (info.exists) installedStudioPocket = { path: TARGET_APK, sizeBytes: info.size, sha256: await p.sha256File(dumped) };
            } finally {
                await p.remove(dumped).catch(() => undefined);
            }
            problems.push(`${ALREADY_RUNS_STUDIO_POCKET} (${TARGET_APK} is installed in place of the stock launcher ${launcherPath})`);
        } else {
            problems.push(`stock launcher ${launcherPath} not found in the image`);
        }
    } else {
        const dumped = p.join(p.tmpDir(), `myo-launcher-${p.uniqueId()}.apk`);
        try {
            await debugfsQuery(p, image, `dump ${launcherPath} ${quoteHostPath(dumped)}`);
            const info = await p.stat(dumped);
            if (!info.exists) problems.push(`could not read ${launcherPath} back from the image`);
            else launcher = { path: launcherPath, sizeBytes: info.size, sha256: await p.sha256File(dumped) };
        } finally {
            await p.remove(dumped).catch(() => undefined);
        }
    }
    if (launcher && manifest) {
        const expected = manifest.stockLauncher;
        if (expected.sizeBytes !== launcher.sizeBytes) problems.push(`stock launcher is ${launcher.sizeBytes} B, manifest ${manifest.firmwareVersion} expects ${expected.sizeBytes} B`);
        if (expected.sha256 && expected.sha256 !== launcher.sha256) problems.push(`stock launcher hash ${launcher.sha256.slice(0, 16)}… does not match manifest ${manifest.firmwareVersion} (${expected.sha256.slice(0, 16)}…)`);
    }
    return {
        buildIncremental,
        build,
        fingerprint: props['ro.build.fingerprint'] ?? '',
        displayId: props['ro.build.display.id'] ?? '',
        fmRadio: props['fmradio.driver.enable'] === '1',
        fsUuid: kind.superblock.uuid,
        installedStudioPocket,
        launcher,
        manifest,
        problems,
    };
}
