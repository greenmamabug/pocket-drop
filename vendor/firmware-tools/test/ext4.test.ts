// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { describe, expect, it } from 'vitest';
import { EXT4_MAGIC, parseSparseHeader, parseSuperblock, SPARSE_MAGIC } from '../src/ext4.js';

describe('image identification', () => {
    it('parses a synthetic ext4 superblock', () => {
        const buffer = Buffer.alloc(4096);
        const sb = buffer.subarray(1024);
        sb.writeUInt32LE(52528, 0);      // inodes
        sb.writeUInt32LE(209920, 4);     // blocks
        sb.writeUInt32LE(80373, 12);     // free blocks
        sb.writeUInt32LE(2, 24);         // log block size -> 4096
        sb.writeUInt16LE(EXT4_MAGIC, 56);
        sb.write('system', 120, 'utf8');
        sb.writeUInt16LE(13, 0x34);      // mount count
        Buffer.from('da594c539bebf85c85c5cedf76546f7a', 'hex').copy(sb, 0x68);
        expect(parseSuperblock(buffer)).toEqual({
            inodesCount: 52528, blocksCount: 209920, freeBlocks: 80373, freeInodes: 0, blockSize: 4096, volumeName: 'system', fsBytes: 859832320,
            uuid: 'da594c539bebf85c85c5cedf76546f7a', mountCount: 13,
        });
    });

    it('recognises an Android sparse header', () => {
        const buffer = Buffer.alloc(28);
        buffer.writeUInt32LE(SPARSE_MAGIC, 0);
        buffer.writeUInt32LE(4096, 12);
        buffer.writeUInt32LE(209920, 16);
        buffer.writeUInt32LE(7, 20);
        expect(parseSparseHeader(buffer)).toEqual({ kind: 'sparse', blockSize: 4096, totalBlocks: 209920, totalChunks: 7, expandedBytes: 859832320 });
        expect(parseSuperblock(Buffer.alloc(4096))).toBeNull();
    });
});
