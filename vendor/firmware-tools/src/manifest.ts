// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

export interface ManifestFile {
    sha256: string;
    sizeBytes: number;
    format?: string;
}

export interface ManifestPartition {
    index: number;
    name: string;
    file: string | null;
    physicalStart: string;
    size: string;
    region?: string;
    op: string;
    download: boolean;
    studioPocketTouches: boolean;
    note?: string;
}

export interface FirmwareManifest {
    device: string;
    firmwareVersion: string;
    source: { url: string; asset: string; sha256: string; sizeBytes: number; note?: string };
    platform: { soc: string; mediatekProject: string; android: string; apiLevel: number; buildId: string; buildFingerprint: string; swVersion?: string; customBuildVersion?: string; fmRadio?: boolean };
    files: Record<string, ManifestFile>;
    partitions: ManifestPartition[];
    linearAddressOffset: string;
    stockLauncher: { path: string; package: string; versionName: string; homeActivity: string; sizeBytes: number; sha256?: string };
}

export class ManifestError extends Error {}

/** Parses and sanity-checks a firmware manifest (src/manifests/*.json). */
export function parseManifest(text: string): FirmwareManifest {
    let manifest: FirmwareManifest;
    try {
        manifest = JSON.parse(text) as FirmwareManifest;
    } catch (error) {
        throw new ManifestError(`manifest is not valid JSON: ${(error as Error).message}`);
    }
    validateManifest(manifest);
    return manifest;
}

/**
 * Structural invariants every manifest must satisfy. These are the rules the
 * installer relies on, so they are checked here rather than trusted.
 */
export function validateManifest(manifest: FirmwareManifest): void {
    const problems: string[] = [];
    if (!manifest.files?.['system.img']) problems.push('files.system.img is required');
    if (!manifest.files?.['MT6582_Android_scatter.txt']) problems.push('files.MT6582_Android_scatter.txt is required');
    if (!/^[0-9a-f]{64}$/.test(manifest.source?.sha256 ?? '')) problems.push('source.sha256 must be a hex SHA-256');

    const partitions = manifest.partitions ?? [];
    const touched = partitions.filter((p) => p.studioPocketTouches);
    if (touched.length !== 1 || touched[0]?.name !== 'ANDROID') {
        problems.push('exactly one partition (ANDROID) may be marked studioPocketTouches');
    }
    for (const partition of touched) {
        if (!partition.download || partition.op !== 'UPDATE') {
            problems.push(`${partition.name} must be a downloadable UPDATE partition to be touched`);
        }
    }
    const protectedNames = ['PRELOADER', 'MBR', 'EBR1', 'EBR2', 'UBOOT', 'BOOTIMG', 'RECOVERY', 'SEC_RO', 'LOGO', 'CACHE', 'USRDATA', 'NVRAM', 'PRO_INFO', 'PROTECT_F', 'PROTECT_S', 'SECCFG'];
    for (const name of protectedNames) {
        const partition = partitions.find((p) => p.name === name);
        if (partition?.studioPocketTouches) problems.push(`${name} must never be touched`);
    }
    const indexes = partitions.map((p) => p.index);
    if (new Set(indexes).size !== indexes.length) problems.push('partition indexes must be unique');

    if (problems.length) throw new ManifestError(`invalid manifest: ${problems.join('; ')}`);
}

export function targetPartition(manifest: FirmwareManifest): ManifestPartition {
    const partition = manifest.partitions.find((p) => p.studioPocketTouches);
    if (!partition) throw new ManifestError('manifest has no target partition');
    return partition;
}
