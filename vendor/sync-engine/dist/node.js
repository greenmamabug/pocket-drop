// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { nodeLibraryFs } from '@studio-pocket/library-format/node';
import { inspectDevice as inspectDeviceWith, ensureDeviceMarker as ensureDeviceMarkerWith, writeAtomic as writeAtomicWith } from './device.js';
import { planTransfer as planTransferWith } from './plan.js';
import { applySync as applySyncWith } from './apply.js';
export const nodeSyncFs = {
    ...nodeLibraryFs,
    readdir: async (dir) => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    },
    mkdirp: async (dir) => { await mkdir(dir, { recursive: true }); },
    writeFile: (file, data) => writeFile(file, data),
    readBytes: async (file) => new Uint8Array(await readFile(file)),
    rename,
    remove: (p, recursive) => rm(p, { recursive, force: true }),
    copyFile: async (from, to) => { await copyFile(from, to); },
    freeBytes: async (dir) => {
        try {
            const { statfs } = await import('node:fs/promises');
            const s = await statfs(dir);
            return Number(s.bavail) * Number(s.bsize);
        }
        catch {
            return null;
        }
    },
    sha256Bytes: async (data) => createHash('sha256').update(data).digest('hex'),
    randomId: () => randomUUID(),
    relative: (root, to) => path.relative(root, to).split(path.sep).join('/'),
};
/** Node conveniences: the functions above bound to the Node file system, with plain paths. */
export const inspectDevice = (volume) => inspectDeviceWith(nodeSyncFs, volume);
export const ensureDeviceMarker = (volume, createdBy) => ensureDeviceMarkerWith(nodeSyncFs, volume, createdBy);
export const writeAtomic = (file, data) => writeAtomicWith(nodeSyncFs, file, data);
export const planTransfer = (root, request, options = {}) => planTransferWith(nodeSyncFs, root, request, options);
export const applySync = (plan, options) => applySyncWith(nodeSyncFs, plan, options);
//# sourceMappingURL=node.js.map