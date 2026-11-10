// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
import { parseSuperblock, SUPERBLOCK_PROBE_BYTES } from './ext4.js';
import { targetPartition } from './manifest.js';
/**
 * Where the system partition really is on a unit, measured from the device itself.
 *
 * Why: the archive scatter is not necessarily the unit's layout (the tested Y2 has ANDROID
 * 0x880000 before the scatter's linear address), partition names are not available
 * (no PMT, no MBR mtkclient can parse), and mtkclient addresses are linear user-area
 * offsets. So the read reads a window that certainly contains the partition, finds the
 * system ext4 superblock in it, and only trusts the result for a write when the NEXT
 * partition's superblock (CACHE is ext4 on the Y2) sits exactly where the system filesystem
 * ends. Two independent markers, or no write.
 */
export const LAYOUT_FILE = 'device-layout.json';
export const DEFAULT_SCAN_ALIGN = 0x10000;
export const DEFAULT_MAX_SCAN = 64 * 1024 * 1024;
/**
 * The window a first read on an unknown unit covers: from `linearAddressOffset` before the
 * scatter's ANDROID (linear) address up to the scatter's CACHE (linear) address. For the
 * Y2 manifests that is 0x5180000 + 0x34800000: any layout where ANDROID moved up to
 * 0x1400000 earlier than the scatter says is captured together with its end marker.
 */
export function windowForManifest(manifest) {
    const offset = Number.parseInt(manifest.linearAddressOffset, 16);
    const android = targetPartition(manifest);
    const cache = manifest.partitions.find((p) => p.name === 'CACHE');
    if (!cache)
        throw new Error('manifest has no CACHE partition to bound the read window');
    const androidLinear = Number.parseInt(android.physicalStart, 16) + offset;
    const cacheLinear = Number.parseInt(cache.physicalStart, 16) + offset;
    const start = androidLinear - offset;
    return { start, length: cacheLinear - start };
}
/** First ext4 superblock at `align` boundaries within the first `maxScan` bytes of `file`. */
export async function findSystemFs(p, file, options = {}) {
    const align = options.align ?? DEFAULT_SCAN_ALIGN;
    const size = (await p.stat(file)).size;
    const limit = Math.min(size, options.maxScan ?? DEFAULT_MAX_SCAN);
    for (let offset = 0; offset + SUPERBLOCK_PROBE_BYTES <= limit; offset += align) {
        const superblock = parseSuperblock(await p.readBytes(file, offset, SUPERBLOCK_PROBE_BYTES));
        if (superblock)
            return { offset, superblock };
    }
    return null;
}
export class LayoutError extends Error {
}
/**
 * Measures the system partition inside `windowFile` (a read that started at linear address
 * `windowStart`). Throws LayoutError when no ext4 superblock is found; `trustedForWrite` is
 * false when the end marker is missing (the read was too short, or the layout is not the one
 * this tool understands).
 */
export async function measureLayout(p, windowFile, windowStart, options = {}) {
    const hit = await findSystemFs(p, windowFile, options);
    if (!hit)
        throw new LayoutError('no ext4 superblock found in the read window: this is not the layout the tool understands');
    const sb = hit.superblock;
    const start = windowStart + hit.offset;
    const size = sb.fsBytes;
    const end = start + size;
    const probe = await p.readBytes(windowFile, hit.offset + size, SUPERBLOCK_PROBE_BYTES);
    const next = probe.length >= SUPERBLOCK_PROBE_BYTES ? parseSuperblock(probe) : null;
    const endMarker = next ? { start: end, size: next.fsBytes, uuid: next.uuid } : null;
    const toHex = (n) => `0x${n.toString(16)}`;
    return {
        measured: new Date().toISOString(),
        method: 'read-only mtkclient read; addresses are mtkclient linear user-area offsets; end marker = next partition superblock',
        windowStart,
        android: { start, size, end, uuid: sb.uuid, blocks: sb.blocksCount, blockSize: sb.blockSize, mountCount: sb.mountCount },
        endMarker,
        trustedForWrite: endMarker !== null,
        hex: { androidStart: toHex(start), androidSize: toHex(size), androidEnd: toHex(end) },
    };
}
export async function writeLayout(p, dir, layout) {
    const file = p.join(dir, LAYOUT_FILE);
    await p.writeText(file, JSON.stringify(layout, null, 2) + '\n');
    return file;
}
export async function readLayout(p, dir) {
    const file = p.join(dir, LAYOUT_FILE);
    if (!(await p.stat(file)).exists)
        return null;
    try {
        const layout = JSON.parse(await p.readText(file));
        if (!layout.android || typeof layout.android.start !== 'number' || typeof layout.android.size !== 'number')
            return null;
        return layout;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=layout.js.map