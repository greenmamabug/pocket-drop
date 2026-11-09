// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { nodeLibraryFs } from '@studio-pocket/library-format/node';
import type { SyncFs } from './fs.js';
import { inspectDevice as inspectDeviceWith, ensureDeviceMarker as ensureDeviceMarkerWith, writeAtomic as writeAtomicWith, type DeviceInfo } from './device.js';
import { planTransfer as planTransferWith, type SyncPlan, type TransferRequest } from './plan.js';
import { applySync as applySyncWith, type ApplyOptions, type ApplyResult } from './apply.js';
import type { DeviceMarker } from '@studio-pocket/library-format';

export const nodeSyncFs: SyncFs = {
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
        } catch {
            return null;
        }
    },
    sha256Bytes: async (data) => createHash('sha256').update(data).digest('hex'),
    randomId: () => randomUUID(),
    relative: (root, to) => path.relative(root, to).split(path.sep).join('/'),
};

/** Node conveniences: the functions above bound to the Node file system, with plain paths. */
export const inspectDevice = (volume: string): Promise<DeviceInfo> => inspectDeviceWith(nodeSyncFs, volume);
export const ensureDeviceMarker = (volume: string, createdBy: string): Promise<DeviceMarker> => ensureDeviceMarkerWith(nodeSyncFs, volume, createdBy);
export const writeAtomic = (file: string, data: string | Uint8Array): Promise<void> => writeAtomicWith(nodeSyncFs, file, data);
export const planTransfer = (root: string, request: TransferRequest, options: { verifyHashes?: boolean } = {}): Promise<SyncPlan> => planTransferWith(nodeSyncFs, root, request, options);
export const applySync = (plan: SyncPlan, options: ApplyOptions): Promise<ApplyResult> => applySyncWith(nodeSyncFs, plan, options);
