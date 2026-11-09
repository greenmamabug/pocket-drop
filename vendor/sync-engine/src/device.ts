// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import {
    DEVICE_FILE, DEVICE_FORMAT, FORMAT_VERSION, LIBRARY_FILE, PARTIAL_SUFFIX, ROOT_DIR,
    parseWith, validateDeviceMarker, type DeviceMarker,
} from '@studio-pocket/library-format';
import type { SyncFs } from './fs.js';

/**
 * Identifying a mounted player. It works on any directory (tests use a temp dir);
 * the commands pass the mount point of the Y2's USB volume.
 */
export interface DeviceInfo {
    root: string;
    marker: DeviceMarker | null;
    hasLibrary: boolean;
    freeBytes: number | null;
}

export async function inspectDevice(fs: SyncFs, volume: string): Promise<DeviceInfo> {
    const root = fs.join(volume, ROOT_DIR);
    let marker: DeviceMarker | null = null;
    try {
        marker = parseWith(validateDeviceMarker, await fs.readText(fs.join(root, DEVICE_FILE)), DEVICE_FILE);
    } catch {
        marker = null;
    }
    const hasLibrary = (await fs.stat(fs.join(root, LIBRARY_FILE))).exists;
    return { root, marker, hasLibrary, freeBytes: await fs.freeBytes(volume) };
}

/** Creates the root and marker if absent. Idempotent. */
export async function ensureDeviceMarker(fs: SyncFs, volume: string, createdBy: string): Promise<DeviceMarker> {
    const root = fs.join(volume, ROOT_DIR);
    await fs.mkdirp(root);
    const existing = await inspectDevice(fs, volume);
    if (existing.marker) return existing.marker;
    const marker: DeviceMarker = { format: DEVICE_FORMAT, formatVersion: FORMAT_VERSION, deviceId: fs.randomId(), createdAt: new Date().toISOString(), createdBy };
    await writeAtomic(fs, fs.join(root, DEVICE_FILE), JSON.stringify(marker, null, 2) + '\n');
    return marker;
}

/**
 * Write to `<file>.part` then rename over the target. On FAT this is not a true atomic
 * replace, but the window is a single directory-entry update instead of a partial file,
 * and readers never open `.part` names.
 */
export async function writeAtomic(fs: SyncFs, file: string, data: string | Uint8Array): Promise<void> {
    const partial = file + PARTIAL_SUFFIX;
    await fs.writeFile(partial, data);
    await fs.rename(partial, file);
}
