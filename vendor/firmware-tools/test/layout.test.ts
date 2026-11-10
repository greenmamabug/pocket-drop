// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXT4_MAGIC } from '../src/ext4.js';
import { findSystemFs, LayoutError, measureLayout, readLayout, windowForManifest, writeLayout } from '../src/layout.js';
import { loadManifest, nodePlatform } from '../src/node.js';

const manifests = ['y2-stock-3.2.1.json', 'y2-stock-3.2.0-fm.json'].map((n) => new URL(`../src/manifests/${n}`, import.meta.url).pathname);

/** A fake ext4 superblock region (only the fields the parser reads) for `blocks` 4 KiB blocks. */
function superblock(blocks: number, uuid: string, mountCount = 0): Buffer {
    const buffer = Buffer.alloc(2048);
    const sb = buffer.subarray(1024);
    sb.writeUInt32LE(1000, 0);
    sb.writeUInt32LE(blocks, 4);
    sb.writeUInt32LE(2, 24);
    sb.writeUInt16LE(mountCount, 0x34);
    sb.writeUInt16LE(EXT4_MAGIC, 56);
    Buffer.from(uuid, 'hex').copy(sb, 0x68);
    return buffer;
}

describe('read window', () => {
    it('spans from the boot-region offset before the scatter ANDROID address to the scatter CACHE address', async () => {
        for (const file of manifests) {
            const m = await loadManifest(file);
            expect(windowForManifest(m)).toEqual({ start: 0x5180000, length: 0x34800000 });
        }
    });
});

describe('layout measurement', () => {
    it('finds the system filesystem and requires the end marker', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'myo-layout-'));
        try {
            const windowStart = 0x5180000;
            const fsOffset = 0xb80000;                 // where the tested unit had it: 0x5D00000 linear
            const fsBlocks = 2048;                     // 8 MiB
            const fsBytes = fsBlocks * 4096;
            const windowFile = path.join(dir, 'window.img');
            const fh = await open(windowFile, 'w');
            await fh.truncate(fsOffset + fsBytes + 1 << 20);
            await fh.write(superblock(fsBlocks, 'da594c539bebf85c85c5cedf76546f7a', 13), 0, 2048, fsOffset);
            await fh.write(superblock(512, '57f8f4bcabf4655fbf67946fc0f9f25b'), 0, 2048, fsOffset + fsBytes);
            await fh.close();

            expect(await findSystemFs(nodePlatform, windowFile)).toMatchObject({ offset: fsOffset, superblock: { blocksCount: fsBlocks, uuid: 'da594c539bebf85c85c5cedf76546f7a', mountCount: 13 } });
            const layout = await measureLayout(nodePlatform, windowFile, windowStart);
            expect(layout.android).toEqual({ start: 0x5d00000, size: fsBytes, end: 0x5d00000 + fsBytes, uuid: 'da594c539bebf85c85c5cedf76546f7a', blocks: fsBlocks, blockSize: 4096, mountCount: 13 });
            expect(layout.endMarker).toEqual({ start: 0x5d00000 + fsBytes, size: 512 * 4096, uuid: '57f8f4bcabf4655fbf67946fc0f9f25b' });
            expect(layout.trustedForWrite).toBe(true);
            expect(layout.hex).toEqual({ androidStart: '0x5d00000', androidSize: '0x800000', androidEnd: '0x6500000' });

            await writeLayout(nodePlatform, dir, layout);
            expect(await readLayout(nodePlatform, dir)).toEqual(layout);

            // Without the next partition's superblock the size cannot be trusted.
            const short = path.join(dir, 'short.img');
            const sh = await open(short, 'w');
            await sh.truncate(fsOffset + fsBytes - 4096);
            await sh.write(superblock(fsBlocks, 'da594c539bebf85c85c5cedf76546f7a'), 0, 2048, fsOffset);
            await sh.close();
            const untrusted = await measureLayout(nodePlatform, short, windowStart);
            expect(untrusted.endMarker).toBeNull();
            expect(untrusted.trustedForWrite).toBe(false);

            // Nothing ext4 at all.
            const empty = path.join(dir, 'empty.img');
            await writeFile(empty, Buffer.alloc(4 << 20));
            await expect(measureLayout(nodePlatform, empty, windowStart)).rejects.toBeInstanceOf(LayoutError);
            expect(await readLayout(nodePlatform, path.join(dir, 'nowhere'))).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
