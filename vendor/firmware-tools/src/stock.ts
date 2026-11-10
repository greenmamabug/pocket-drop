// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import type { FirmwareManifest } from './manifest.js';
import { parseScatter, type Scatter } from './scatter.js';
import { identifyImage } from './ext4.js';
import type { FirmwarePlatform } from './platform.js';

/**
 * Verifies a user-supplied stock firmware package against the manifest and extracts
 * the two files Studio Pocket needs. The package is never downloaded by this code.
 */
export interface StockInputs {
    systemImage: string;
    scatterPath: string;
    scatter: Scatter;
    systemSha256: string;
    scatterSha256: string;
    zipSha256?: string;
}

export class StockError extends Error {}

export const STOCK_FILES = ['system.img', 'MT6582_Android_scatter.txt'] as const;

export interface StockProgress {
    stage: 'hash-zip' | 'extract' | 'hash-system';
    bytes: number;
    total: number;
}

/**
 * `source` is either the stock zip (hashed against the manifest, then the two files are
 * extracted into `<workDir>/stock`) or a directory already holding them.
 */
export async function prepareStock(p: FirmwarePlatform, source: string, manifest: FirmwareManifest, workDir: string, log: (line: string) => void = () => undefined, onProgress?: (e: StockProgress) => void): Promise<StockInputs> {
    const info = await p.stat(source);
    if (!info.exists) throw new StockError(`${source} does not exist`);
    let dir = source;
    let zipSha256: string | undefined;
    if (!info.isDir) {
        log(`hashing ${p.basename(source)}`);
        zipSha256 = await p.sha256File(source, (bytes) => onProgress?.({ stage: 'hash-zip', bytes, total: info.size }));
        if (zipSha256 !== manifest.source.sha256) {
            throw new StockError(`${p.basename(source)} SHA-256 ${zipSha256} does not match manifest ${manifest.source.sha256} (${manifest.firmwareVersion})`);
        }
        dir = p.join(workDir, 'stock');
        await p.mkdirp(dir);
        log(`extracting ${STOCK_FILES.join(', ')} -> ${dir}`);
        await p.zipExtract(source, [...STOCK_FILES], dir, (bytes, total) => onProgress?.({ stage: 'extract', bytes, total }));
    }
    const systemImage = p.join(dir, 'system.img');
    const scatterPath = p.join(dir, 'MT6582_Android_scatter.txt');
    const systemInfo = await p.stat(systemImage);
    if (!systemInfo.exists) throw new StockError(`${systemImage} is missing`);
    const systemSha256 = await p.sha256File(systemImage, (bytes) => onProgress?.({ stage: 'hash-system', bytes, total: systemInfo.size }));
    const scatterSha256 = await p.sha256File(scatterPath);
    const expectedSystem = manifest.files['system.img']?.sha256;
    const expectedScatter = manifest.files['MT6582_Android_scatter.txt']?.sha256;
    if (systemSha256 !== expectedSystem) throw new StockError(`system.img SHA-256 ${systemSha256} != manifest ${expectedSystem}`);
    if (scatterSha256 !== expectedScatter) throw new StockError(`scatter SHA-256 ${scatterSha256} != manifest ${expectedScatter}`);
    const kind = await identifyImage(p, systemImage);
    if (kind.kind !== 'ext4') throw new StockError(`system.img is ${kind.kind}, expected raw ext4`);
    const scatter = parseScatter(await p.readText(scatterPath));
    const result: StockInputs = { systemImage, scatterPath, scatter, systemSha256, scatterSha256 };
    if (zipSha256) result.zipSha256 = zipSha256;
    return result;
}

/**
 * Which known firmware a user-supplied package is, by hash: the zip's SHA-256 for a zip, the
 * system.img's for an unpacked folder. Returns null when nothing matches, so callers can say
 * "not a supported firmware" with the versions they do know.
 */
export async function identifyStock(p: FirmwarePlatform, source: string, manifests: FirmwareManifest[], onProgress?: (bytes: number, total: number) => void): Promise<{ manifest: FirmwareManifest; sha256: string; kind: 'zip' | 'dir' } | null> {
    const info = await p.stat(source);
    if (!info.exists) throw new StockError(`${source} does not exist`);
    if (info.isDir) {
        const image = p.join(source, 'system.img');
        const imageInfo = await p.stat(image);
        if (!imageInfo.exists) throw new StockError(`${image} is missing`);
        const sha256 = await p.sha256File(image, (b) => onProgress?.(b, imageInfo.size));
        const manifest = manifests.find((m) => m.files['system.img']?.sha256 === sha256);
        return manifest ? { manifest, sha256, kind: 'dir' } : null;
    }
    const sha256 = await p.sha256File(source, (b) => onProgress?.(b, info.size));
    const manifest = manifests.find((m) => m.source.sha256 === sha256);
    return manifest ? { manifest, sha256, kind: 'zip' } : null;
}
