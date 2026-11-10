// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
export const EXT4_MAGIC = 0xef53;
export const SPARSE_MAGIC = 0xed26ff3a;
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
export function parseSuperblock(buffer) {
    if (buffer.length < 1024 + 264)
        return null;
    const sb = buffer.subarray(1024);
    const dv = view(sb);
    if (dv.getUint16(56, true) !== EXT4_MAGIC)
        return null;
    const blockSize = 1024 << dv.getUint32(24, true);
    const blocksLo = dv.getUint32(4, true);
    const incompat = dv.getUint32(96, true);
    const is64 = (incompat & 0x80) !== 0;
    const blocksHi = is64 && sb.length >= 0x154 ? dv.getUint32(0x150, true) : 0;
    const blocksCount = blocksHi * 2 ** 32 + blocksLo;
    const name = sb.subarray(120, 136);
    const end = name.indexOf(0);
    return {
        inodesCount: dv.getUint32(0, true),
        blocksCount,
        freeBlocks: dv.getUint32(12, true),
        freeInodes: dv.getUint32(16, true),
        blockSize,
        volumeName: new TextDecoder().decode(name.subarray(0, end === -1 ? 16 : end)),
        fsBytes: blocksCount * blockSize,
        uuid: Array.from(sb.subarray(0x68, 0x78), (b) => b.toString(16).padStart(2, '0')).join(''),
        mountCount: dv.getUint16(0x34, true),
    };
}
/** Bytes needed from the start of a filesystem to parse its primary superblock. */
export const SUPERBLOCK_PROBE_BYTES = 2048;
export function parseSparseHeader(buffer) {
    if (buffer.length < 28)
        return null;
    const dv = view(buffer);
    if (dv.getUint32(0, true) !== SPARSE_MAGIC)
        return null;
    const blockSize = dv.getUint32(12, true);
    const totalBlocks = dv.getUint32(16, true);
    return { kind: 'sparse', blockSize, totalBlocks, totalChunks: dv.getUint32(20, true), expandedBytes: blockSize * totalBlocks };
}
export function identifyBytes(head) {
    const sparse = parseSparseHeader(head);
    if (sparse)
        return sparse;
    const superblock = parseSuperblock(head);
    if (superblock)
        return { kind: 'ext4', superblock };
    return { kind: 'unknown' };
}
export async function identifyImage(p, path) {
    return identifyBytes(await p.readBytes(path, 0, 4096));
}
//# sourceMappingURL=ext4.js.map